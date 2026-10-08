import {canonicalLocale, localeDirection} from './core.js';
const ATTRIBUTES = ['title', 'alt', 'placeholder', 'aria-label', 'aria-description'];
const SKIP_ELEMENTS = new Set(['SCRIPT', 'STYLE', 'CODE', 'PRE', 'NOSCRIPT', 'MATH']);

/** Capture an English/source-language view for ahead-of-use cache preparation. */
export async function captureDOM(root, {sourceLocale = 'en'} = {}) {
  sourceLocale = canonicalLocale(sourceLocale);
  const wrapper = wrapDOM(root, {locale:sourceLocale, engine:{sourceLocale, translate(){throw new Error('Source capture must not translate.');}}});
  try {
    const report = await wrapper.ready;
    return {sourceLocale, segments:report.segments.map(({id,source,context,kind})=>({id,source,context,kind})), issues:report.issues};
  } finally { wrapper.disconnect(); }
}

export function wrapDOM(root, { engine, locale = engine?.sourceLocale ?? 'en', onReport } = {}) {
  if (!root || typeof root !== 'object') throw new TypeError('wrapDOM requires a DOM root');
  if (!engine || typeof engine.translate !== 'function') throw new TypeError('wrapDOM requires an engine');

  const document = root.nodeType === 9 ? root : root.ownerDocument;
  const records = new Map();
  const observers = new Map();
  let nextId = 1;
  let currentLocale = canonicalLocale(locale);
  let generation = 0;
  let controller;
  let disconnected = false;
  let autoQueued = false;
  let lastReportKey = '';
  let state = makeReport(currentLocale);
  const languageRoot = root.nodeType === 9 ? root.documentElement : root.nodeType === 1 ? root : root.host;
  const originalLanguage = languageRoot?.getAttribute('lang');
  const originalDirection = languageRoot?.getAttribute('dir');

  function makeReport(reportLocale) {
    return {
      locale: reportLocale,
      total: 0,
      translated: 0,
      source: 0,
      missing: 0,
      rejected: 0,
      errors: 0,
      needsReview: 0,
      issues: [],
      segments: [],
      pending: false,
    };
  }

  function valueOf(record) {
    return record.attr ? record.node.getAttribute(record.attr) : record.node.nodeValue;
  }

  function write(record, value) {
    record.lastWritten = value;
    if (record.attr) record.node.setAttribute(record.attr, value);
    else record.node.nodeValue = value;
  }

  function elementFor(node) {
    return node.nodeType === 1 ? node : node.parentElement;
  }

  function excluded(node) {
    let element = elementFor(node);
    let editableDetermined = false;
    while (element) {
      if (SKIP_ELEMENTS.has(element.tagName?.toUpperCase())) return true;
      if (element.matches?.('[translate="no"], [data-everyword-ignore]')) return true;
      if (!editableDetermined && element.hasAttribute?.('contenteditable')) {
        editableDetermined = true;
        if (element.getAttribute('contenteditable') !== 'false') return true;
      }
      if (node.nodeType === 3 && /^(INPUT|TEXTAREA|SELECT)$/.test(element.tagName)) return true;
      const tree = element.getRootNode?.();
      element = element.parentElement || (tree && tree.host) || null;
    }
    return false;
  }

  function originalText(element) {
    if (!element || excluded(element)) return '';
    const walker = element.ownerDocument.createTreeWalker(element, 0x4);
    const parts = []; let node;
    while ((node = walker.nextNode())) if(!excluded(node))parts.push(records.get(node)?.get('#text')?.source ?? node.nodeValue);
    return parts.join(' ').replace(/\s+/g, ' ').trim().slice(0, 300);
  }

  function contextFor(node, kind) {
    const element = elementFor(node);
    const tag = element?.tagName?.toLowerCase() || 'document';
    const identity = element?.id ? `#${element.id}` : '';
    const contextElement = element?.closest('[data-everyword-context]');
    const explicit = contextElement && belongsToRoot(contextElement) ? contextElement.getAttribute('data-everyword-context') : null;
    const candidate = element?.closest('article, section, main, dialog, [role="dialog"]');
    const scope = candidate && belongsToRoot(candidate) ? candidate : (root.nodeType === 9 ? root.body : root);
    const heading = scope?.querySelector?.('h1, h2, h3, [role="heading"]');
    return `${tag}${identity}:${kind}${explicit ? '; '+explicit.slice(0,300) : ''}${heading ? '; heading='+originalText(heading) : ''}`.slice(0,1000);
  }

  function belongsToRoot(node) {
    if (node === root || root.contains(node)) return true;
    const tree = node.getRootNode();
    if (tree.host) return belongsToRoot(tree.host);
    const frame = tree.nodeType === 9 ? tree.defaultView?.frameElement : null;
    return frame ? belongsToRoot(frame) : false;
  }

  function addRecord(node, attr, kind) {
    if (excluded(node)) return;
    const value = attr ? node.getAttribute(attr) : node.nodeValue;
    if (value == null || !value.trim()) return;
    const key = attr ? `${attr}` : '#text';
    let byKind = records.get(node);
    if (!byKind) records.set(node, (byKind = new Map()));
    if (byKind.has(key)) return;
    byKind.set(key, {
      id: `dom-${nextId++}`,
      node,
      attr,
      kind,
      context: contextFor(node, kind),
      source: value,
      version: 0,
      lastWritten: null,
      lastResult: null,
    });
  }

  function inspectElement(element, issues, seenRoots) {
    if (excluded(element)) return false;
    for (const attr of ATTRIBUTES) if (element.hasAttribute(attr)) addRecord(element, attr, attr);
    if (element.tagName === 'INPUT' && /^(button|submit|reset)$/i.test(element.type) && element.hasAttribute('value')) {
      addRecord(element, 'value', 'value');
    }
    if (element.tagName === 'CANVAS') issues.add('canvas-content-unavailable');
    if (element.namespaceURI === 'http://www.w3.org/2000/svg' && ['text','foreignObject'].includes(element.localName)) issues.add('svg-content-limited');
    if (element.tagName.includes('-') && !element.shadowRoot) issues.add('custom-element-internals-unavailable');
    if (element.tagName === 'IMG') issues.add('image-pixels-not-captured');
    if (element.tagName === 'IMG' && !element.hasAttribute('alt')) issues.add('image-without-alt');
    if (element.shadowRoot) scanRoot(element.shadowRoot, issues, seenRoots);
    if (element.tagName === 'IFRAME') {
      try {
        if (element.contentDocument) scanRoot(element.contentDocument, issues, seenRoots);
        else issues.add('frame-inaccessible');
      } catch {
        issues.add('frame-inaccessible');
      }
    }
    return true;
  }

  function scanRoot(scanTarget, issues, seenRoots = new Set()) {
    if (!scanTarget || seenRoots.has(scanTarget) || excluded(scanTarget)) return;
    seenRoots.add(scanTarget);
    observe(scanTarget);
    const walker = (scanTarget.ownerDocument || scanTarget).createTreeWalker(
      scanTarget,
      0x1 | 0x4,
      { acceptNode: node => excluded(node) ? 2 : 1 },
    );
    let node = walker.currentNode;
    while (node) {
      if (node.nodeType === 1) {
        inspectElement(node, issues, seenRoots);
      } else if (node.nodeType === 3) {
        addRecord(node, null, node.parentElement?.tagName === 'TITLE' ? 'document-title' : 'text');
      }
      node = walker.nextNode();
    }
  }

  function reconcile(record) {
    const value = valueOf(record);
    if (value == null) {
      if (!record.removed) {
        record.removed = true;
        record.version++;
        record.lastWritten = null;
        record.lastResult = null;
        return true;
      }
      return false;
    }
    record.removed = false;
    if (value !== record.lastWritten && value !== record.source) {
      record.source = value;
      record.version++;
      record.lastWritten = null;
      record.lastResult = null;
      return true;
    }
    return false;
  }

  function pruneAndReconcile() {
    for (const [target, observer] of observers) {
      const owner = target.nodeType === 9 ? target.defaultView?.frameElement : target.host ?? target;
      if (target !== root && owner && !belongsToRoot(owner)) { observer.disconnect(); observers.delete(target); }
    }
    for (const [node, byKind] of records) {
      if (!belongsToRoot(node)) {
        records.delete(node);
        continue;
      }
      for (const record of byKind.values()) reconcile(record);
    }
  }

  function observe(target) {
    if (observers.has(target) || disconnected) return;
    const ViewObserver = target.ownerDocument?.defaultView?.MutationObserver || document?.defaultView?.MutationObserver;
    if (!ViewObserver) return;
    const observer = new ViewObserver((mutations) => {
      if (disconnected) return;
      let changed = false;
      for (const mutation of mutations) {
        // Status controls and private editors often render in response to a
        // report. Observing their ignored changes creates a refresh loop.
        if (excluded(mutation.target) && !(mutation.type === 'attributes' && ['translate', 'data-everyword-ignore', 'contenteditable'].includes(mutation.attributeName))) continue;
        if (mutation.type === 'characterData') {
          const record = records.get(mutation.target)?.get('#text');
          if (record) changed = reconcile(record) || changed;
          else changed = true;
        } else if (mutation.type === 'attributes') {
          const record = records.get(mutation.target)?.get(mutation.attributeName);
          if (record) changed = reconcile(record) || changed;
          else changed = true;
        } else {
          changed = true;
        }
      }
      if (changed) queueAutomaticRefresh();
    });
    observer.observe(target, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: [...ATTRIBUTES, 'value', 'translate', 'data-everyword-ignore', 'contenteditable'],
    });
    observers.set(target, observer);
  }

  function queueAutomaticRefresh() {
    if (autoQueued || disconnected) return;
    autoQueued = true;
    queueMicrotask(async () => {
      autoQueued = false;
      try {
        await run(currentLocale);
      } catch (error) {
        if (error?.name !== 'AbortError') publishError(error);
      }
    });
  }

  function allRecords() {
    return [...records.values()].flatMap((byKind) => [...byKind.values()]);
  }

  function publish(next) {
    state = next;
    const key = JSON.stringify(next);
    if (onReport && key !== lastReportKey) {
      lastReportKey = key;
      onReport(next);
    }
    return next;
  }

  function publishError(error) {
    const next = { ...state, pending: false, errors: state.errors + 1, issues: [...state.issues, `adapter-error: ${error?.message || error}`] };
    return publish(next);
  }

  async function run(targetLocale) {
    if (disconnected) return state;
    targetLocale = canonicalLocale(targetLocale);
    const request = ++generation;
    controller?.abort();
    controller = new AbortController();
    const issues = new Set();
    scanRoot(root, issues);
    pruneAndReconcile();
    const active = allRecords().filter((record) => !record.removed && valueOf(record) != null && !excluded(record.node));
    for (const record of active) {
      const context = contextFor(record.node, record.kind);
      if (context !== record.context) { record.context = context; record.version++; record.lastResult = null; }
    }
    const next = makeReport(targetLocale);
    languageRoot?.setAttribute('lang', targetLocale);
    languageRoot?.setAttribute('dir', localeDirection(targetLocale));
    next.total = active.length;
    next.layoutIssues = [];
    next.issues = [...issues];
    next.pending = targetLocale !== engine.sourceLocale && active.length > 0;
    publish(next);

    if (targetLocale === engine.sourceLocale || active.length === 0) {
      for (const record of active) {
        reconcile(record);
        if (valueOf(record) === record.lastWritten || valueOf(record) === record.source) write(record, record.source);
        record.lastResult = { status: 'source', text: record.source };
      }
      next.layoutIssues = auditDOM(root);
      next.issues.push(...next.layoutIssues.map(issue => `layout-clipping: ${issue.element}`));
      next.source = active.length;
      next.pending = false;
      next.segments = active.map((record) => resultEntry(record, record.lastResult));
      return publish(next);
    }

    const snapshots = active.map((record) => ({ record, version: record.version, source: record.source, context: record.context }));
    let results;
    try {
      results = await engine.translate(snapshots.map(({ record, source }) => ({
        id: record.id,
        source,
        context: record.context,
        kind: record.kind,
      })), { locale: targetLocale, signal: controller.signal });
    } catch (error) {
      if (error?.name === 'AbortError') return state;
      if (request !== generation) return state;
      return publishError(error);
    }
    if (request !== generation || disconnected) return state;

    const byId = new Map((results || []).map((result) => [result.id, result]));
    for (const snapshot of snapshots) {
      const { record } = snapshot;
      reconcile(record);
      if (!belongsToRoot(record.node) || excluded(record.node) || record.version !== snapshot.version || record.source !== snapshot.source || contextFor(record.node, record.kind) !== snapshot.context) {
        next.source++;
        continue;
      }
      const result = byId.get(record.id) || { id: record.id, source: record.source, text: record.source, status: 'missing', reviewed: false };
      record.lastResult = result;
      const status = result.status === 'needs-review' ? 'needsReview' : result.status === 'error' ? 'errors' : result.status;
      if (Object.hasOwn(next, status)) next[status]++;
      else next.errors++;
      write(record, result.text ?? record.source);
    }
    next.layoutIssues = auditDOM(root);
    next.issues.push(...next.layoutIssues.map(issue => `layout-clipping: ${issue.element}`));
    next.pending = false;
    next.segments = active.map((record) => resultEntry(record, record.lastResult || {
      status: 'source', text: record.source, reason: 'source changed during translation',
    }));
    return publish(next);
  }

  function resultEntry(record, result) {
    return {
      id: record.id,
      context: record.context,
      kind: record.kind,
      source: record.source,
      text: result.text ?? record.source,
      status: result.status,
      reviewed: Boolean(result.reviewed),
      ...(result.reason ? { reason: result.reason } : {}),
    };
  }

  const ready = run(currentLocale);
  return {
    ready,
    async setLocale(nextLocale) {
      currentLocale = canonicalLocale(nextLocale);
      return run(currentLocale);
    },
    async refresh() {
      return run(currentLocale);
    },
    report() {
      return state;
    },
    disconnect({ restore = true } = {}) {
      disconnected = true;
      generation++;
      controller?.abort();
      for (const observer of observers.values()) observer.disconnect();
      observers.clear();
      if (restore) {
        for (const [name, value] of [['lang', originalLanguage], ['dir', originalDirection]]) {
          if (value == null) languageRoot?.removeAttribute(name);
          else languageRoot?.setAttribute(name, value);
        }
        pruneAndReconcile();
        for (const record of allRecords()) {
          if (valueOf(record) === record.lastWritten || valueOf(record) === record.source) write(record, record.source);
        }
      }
      return state;
    },
  };
}

/** Report measurable clipping; this does not prove a complete visual review. */
export function auditDOM(root) {
  const elements = [...(root.nodeType === 1 ? [root] : []), ...root.querySelectorAll('*')];
  const issues = [];
  for (const element of elements) {
    if (!element.textContent.trim() || !element.clientWidth || !element.clientHeight) continue;
    const view = element.ownerDocument.defaultView;
    const style = view?.getComputedStyle(element);
    if (!style || style.visibility === 'hidden' || style.display === 'none') continue;
    const x = /^(hidden|clip)$/.test(style.overflowX) && element.scrollWidth > element.clientWidth + 2;
    const y = /^(hidden|clip)$/.test(style.overflowY) && element.scrollHeight > element.clientHeight + 2;
    if (x || y) issues.push({element:element.localName+(element.id ? '#'+element.id : ''), axis:x&&y?'both':x?'horizontal':'vertical'});
  }
  return issues;
}
