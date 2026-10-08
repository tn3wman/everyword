const DEFAULT_TEXT_KEYS = new Set([
  'text',
  'label',
  'title',
  'description',
  'placeholder',
  'accessibilityLabel',
  'accessibilityHint',
  'tooltip',
  'message',
  'body',
  'subject',
  'alt',
]);

export {localeDirection} from './core.js';
import {canonicalLocale, localeDirection} from './core.js';

function issueFromResult(result) {
  return {
    id: result.id,
    status: result.status,
    source: result.source,
    ...(result.reason ? { reason: result.reason } : {}),
  };
}

function makeReport(locale, results = [], extraIssues = []) {
  const report = {
    locale,
    total: results.length,
    translated: 0,
    source: 0,
    missing: 0,
    rejected: 0,
    errors: 0,
    needsReview: 0,
    issues: [...extraIssues],
    segments: results.map((result) => ({ ...result })),
  };

  report.errors += extraIssues.filter((issue) => issue.status === 'error').length;

  for (const result of results) {
    if (result.status === 'translated') report.translated += 1;
    else if (result.status === 'source') report.source += 1;
    else if (result.status === 'missing') report.missing += 1;
    else if (result.status === 'rejected') report.rejected += 1;
    else if (result.status === 'error') report.errors += 1;
    else if (result.status === 'needs-review') report.needsReview += 1;

    if (!['translated', 'source'].includes(result.status)) {
      report.issues.push(issueFromResult(result));
    }
  }
  return report;
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isOptedOut(value) {
  return isPlainObject(value)
    && (value.localize === false || value.translate === 'no' || value.userInput === true);
}

function pathId(path) {
  return `object:${path.map((part) => String(part).replaceAll('~', '~0').replaceAll('/', '~1')).join('/')}`;
}

function collectObjectSegments(value, textKeys, context) {
  const segments = [];
  const locations = [];
  const visiting = new WeakSet();

  function visit(current, path) {
    if (current === null || typeof current !== 'object' || isOptedOut(current)) return;
    if (!Array.isArray(current) && !isPlainObject(current)) return;
    if (visiting.has(current)) return;
    visiting.add(current);

    for (const [key, child] of Object.entries(current)) {
      const childPath = [...path, key];
      if (key === 'userInput') continue;
      if (textKeys.has(key) && typeof child === 'string') {
        const id = pathId(childPath);
        segments.push({ id, source: child, context: context ? `${context}.${childPath.join('.')}` : childPath.join('.') });
        locations.push({ path: childPath, source: child, id });
      } else {
        visit(child, childPath);
      }
    }
    visiting.delete(current);
  }

  visit(value, []);
  return { segments, locations };
}

function setImmutable(root, path, replacement) {
  if (path.length === 0) return replacement;
  const clone = Array.isArray(root) ? root.slice() : { ...root };
  const value = path.length === 1 ? replacement : setImmutable(root[path[0]], path.slice(1), replacement);
  Object.defineProperty(clone, path[0], {value, writable:true, enumerable:true, configurable:true});
  return clone;
}

function safeText(result, source) {
  if (!result || result.source !== source || typeof result.text !== 'string') return source;
  return ['translated', 'source'].includes(result.status) ? result.text : source;
}

/** Translate known human-facing fields without mutating the input value. */
export async function translateObject(value, { engine, locale, context = '', keys } = {}) {
  if (!engine || typeof engine.translate !== 'function') throw new TypeError('engine.translate is required');
  if (!locale) throw new TypeError('locale is required');
  const textKeys = keys === undefined ? DEFAULT_TEXT_KEYS : new Set(keys);
  const { segments, locations } = collectObjectSegments(value, textKeys, context);
  if (segments.length === 0) return { value, report: makeReport(locale) };

  const outputs = await engine.translate(segments, { locale });
  const metadata = new Map(segments.map(s => [s.id,s]));
  const results = outputs.map(r => ({...metadata.get(r.id),...r}));
  const byId = new Map(results.map((result) => [result.id, result]));
  let translatedValue = value;
  for (const location of locations) {
    const text = safeText(byId.get(location.id), location.source);
    if (text !== location.source) translatedValue = setImmutable(translatedValue, location.path, text);
  }
  return { value: translatedValue, report: makeReport(locale, results) };
}

export const translateMessages = translateObject;

/** Wrap a capture/apply bridge with locale state, cancellation, and coverage reporting. */
export function wrapAdapter(adapter, { engine, locale, onReport } = {}) {
  if (!adapter || typeof adapter.capture !== 'function' || typeof adapter.apply !== 'function') {
    throw new TypeError('adapter.capture and adapter.apply are required');
  }
  if (!engine || typeof engine.translate !== 'function') throw new TypeError('engine.translate is required');

  let currentLocale = canonicalLocale(locale || engine.sourceLocale);
  let generation = 0;
  let controller;
  let disconnected = false;
  let lastReport = makeReport(currentLocale);

  function publish(report) {
    lastReport = report;
    if (typeof onReport === 'function') onReport(report);
    return report;
  }

  async function refresh() {
    if (disconnected) return lastReport;
    const requestGeneration = ++generation;
    const requestLocale = currentLocale;
    controller?.abort();
    const requestController = new AbortController();
    controller = requestController;

    let captured;
    try {
      captured = await adapter.capture();
      if (!Array.isArray(captured)) throw new TypeError('adapter.capture must return an array');
      const segments = captured.map(({ id, source, context, kind }) => ({
        id,
        source,
        ...(context === undefined ? {} : { context }),
        ...(kind === undefined ? {} : { kind }),
      }));
      if (disconnected || requestGeneration !== generation) return lastReport;
      const outputs = await engine.translate(segments, { locale: requestLocale, signal: requestController.signal });
      const metadata = new Map(segments.map(s => [s.id,s]));
      const results = outputs.map(r => ({...metadata.get(r.id),...r}));
      if (disconnected || requestGeneration !== generation) return lastReport;

      const capturedById = new Map(segments.map((segment) => [segment.id, segment]));
      const safeResults = results.map((result) => {
        const source = capturedById.get(result.id)?.source;
        return source === undefined ? null : { ...result, text: safeText(result, source) };
      }).filter(Boolean);
      await adapter.apply(safeResults, { locale: requestLocale, direction: localeDirection(requestLocale), signal: requestController.signal, isCurrent: () => !disconnected && requestGeneration === generation });
      if (disconnected || requestGeneration !== generation) return lastReport;
      return publish(makeReport(requestLocale, results));
    } catch (error) {
      if (disconnected || requestGeneration !== generation || error?.name === 'AbortError') return lastReport;
      return publish(makeReport(requestLocale, [], [{ status: 'error', reason: error?.message || String(error) }]));
    }
  }

  // Host adapters refresh explicitly after mounting or native view changes.
  return {
    get locale() { return currentLocale; },
    async setLocale(nextLocale) {
      if (!nextLocale) throw new TypeError('locale is required');
      currentLocale = canonicalLocale(nextLocale);
      return refresh();
    },
    refresh,
    report() { return lastReport; },
    async disconnect() {
      if (disconnected) return;
      disconnected = true;
      generation += 1;
      controller?.abort();
      if (typeof adapter.restore === 'function') await adapter.restore();
    },
  };
}

function collectMenuSegments(items, context, path = [], segments = [], locations = []) {
  if (!Array.isArray(items)) return { segments, locations };
  items.forEach((item, index) => {
    if (!isPlainObject(item) || isOptedOut(item)) return;
    const itemPath = [...path, index];
    if (typeof item.label === 'string') {
      const id = pathId([...itemPath, 'label']);
      segments.push({ id, source: item.label, context: `${context}.${itemPath.join('.')}.label`, kind: 'menu-label' });
      locations.push({ path: [...itemPath, 'label'], id, source: item.label });
    }
    collectMenuSegments(item.submenu, context, [...itemPath, 'submenu'], segments, locations);
  });
  return { segments, locations };
}

/** Translate an Electron-compatible menu template without importing Electron. */
export async function translateElectronMenu(template, { engine, locale, context = 'electron-menu' } = {}) {
  if (!Array.isArray(template)) throw new TypeError('menu template must be an array');
  if (!engine || typeof engine.translate !== 'function') throw new TypeError('engine.translate is required');
  if (!locale) throw new TypeError('locale is required');
  const { segments, locations } = collectMenuSegments(template, context);
  if (segments.length === 0) return { value: template, report: makeReport(locale) };
  const outputs = await engine.translate(segments, { locale });
  const metadata = new Map(segments.map(s => [s.id,s]));
  const results = outputs.map(r => ({...metadata.get(r.id),...r}));
  const byId = new Map(results.map((result) => [result.id, result]));
  let value = template;
  for (const location of locations) {
    const text = safeText(byId.get(location.id), location.source);
    if (text !== location.source) value = setImmutable(value, location.path, text);
  }
  return { value, report: makeReport(locale, results) };
}
