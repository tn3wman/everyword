const STATUS = ['source', 'translated', 'missing', 'rejected', 'error', 'needs-review'];

export function canonicalLocale(locale) {
  if (typeof locale !== 'string' || !locale.trim()) throw new TypeError('A language code is required.');
  return Intl.getCanonicalLocales(locale)[0];
}

export function localeDirection(locale) {
  const language = new Intl.Locale(canonicalLocale(locale));
  const info = language.getTextInfo?.() ?? language.textInfo;
  return info?.direction ?? (/^(ar|fa|he|ur|ps|sd|ug|yi)(-|$)/i.test(language.toString()) ? 'rtl' : 'ltr');
}

// These tokens are data or interpolation syntax, never natural-language copy.
// Numbered rich-text markers such as <0>, </0> and <1/> (Lingui, react-intl, i18next Trans).
export const PROTECTED_PATTERN = /\{\{[^{}]+\}\}|\$\{[^{}]+\}|\{[\w.]+\}|%(?:\d+\$)?[-+#0 ]*\d*(?:\.\d+)?[sdifuxXoeEgGc]|%\([\w]+\)[sdif]|https?:\/\/[^\s<>]+|[\w.+-]+@[\w.-]+\.[a-zA-Z]{2,}|<\/?\d+\s*\/?>/gu;

export function protectedTokens(text) {
  return (text.match(PROTECTED_PATTERN) ?? []).sort();
}

/** Numbered markers must close in order, so a translation cannot interleave or orphan them. */
export function balancedMarkers(text) {
  const open = [];
  for (const [marker, closing, id, selfClosing] of text.matchAll(/<(\/?)(\d+)\s*(\/?)>/g)) {
    if (selfClosing) continue;
    if (!closing) open.push(id);
    else if (open.pop() !== id) return false;
  }
  return open.length === 0;
}

let digitValues;
// Every decimal digit Intl can format (Devanagari, Han decimal, Arabic-Indic, ...) as its ASCII value.
function asciiDigits(text) {
  if (!digitValues) {
    digitValues = new Map();
    for (const numberingSystem of Intl.supportedValuesOf?.('numberingSystem') ?? []) {
      try {
        const format = new Intl.NumberFormat('en', {numberingSystem, useGrouping: false});
        for (let digit = 0; digit <= 9; digit++) {
          const glyph = format.format(digit);
          if ([...glyph].length === 1 && glyph !== String(digit)) digitValues.set(glyph, String(digit));
        }
      } catch {}
    }
  }
  // Only decimal digits (\p{Nd}). Han numerals (一, 二) are words: "一座山" is "a mountain".
  return text.replace(/\p{Nd}/gu, digit => digitValues.get(digit) ?? digit);
}

/**
 * Digit sequences, compared as a sorted multiset. Grouping and decimal separators between digits are
 * removed on both sides, so 1,670, 1.670, 1 670 and 1670 or Indian 5,22,427 and 522,427 compare equal.
 */
export function numericTokens(text) {
  return (asciiDigits(text)
    .replace(/(?<=\d)[,.'’   ٫٬](?=\d)|(?<=\d) (?=\d{3}(?!\d))/gu, '')
    .match(/\d+/g) ?? []).sort();
}

const MONTHS = ['january','february','march','april','may','june','july','august','september','october','november','december'];

/**
 * The translation keeps every digit sequence of the source. It may add a month's number only for a
 * month the English source names, as Chinese, Japanese and Korean dates write "April 12" as 4月12日.
 */
export function sameNumbers(source, text) {
  const extra = numericTokens(text);
  for (const token of numericTokens(source)) {
    const index = extra.indexOf(token);
    if (index < 0) return false;
    extra.splice(index, 1);
  }
  const months = source.match(/\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\b/g) ?? [];
  for (const month of months) {
    const index = extra.indexOf(String(MONTHS.indexOf(month.toLowerCase()) + 1));
    if (index >= 0) extra.splice(index, 1);
  }
  return extra.length === 0;
}

function sameTokens(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
/**
 * Whole-word match. Source terms match case-sensitively, as DeepL and Google glossaries do, so a
 * product name such as "Contours" does not claim the ordinary word "contours". A required
 * translation may change case, as sentence position or German nouns demand.
 */
// Scripts written without spaces between words: a neighbouring character there never extends a word.
const WORD = '[[\\p{L}\\p{N}_]--[\\p{sc=Han}\\p{sc=Hiragana}\\p{sc=Katakana}\\p{sc=Thai}\\p{sc=Lao}\\p{sc=Khmer}\\p{sc=Myanmar}\\p{sc=Tibetan}]]';
export function hasTerm(text, term, {ignoreCase = false} = {}) {
  const escaped = term.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  return new RegExp(`(?<!${WORD})${escaped}(?!${WORD})`, ignoreCase ? 'iv' : 'v').test(text);
}

export function validateTranslation(source, text, {glossary = {}, preserveNumbers = true} = {}) {
  if (typeof text !== 'string' || !text.trim()) return 'The provider returned empty or invalid text.';
  if (text.length > Math.max(2048, source.length * 8)) return 'The translation is unexpectedly long.';
  if (/\{\s*\w+\s*,\s*(plural|select|selectordinal)\s*,/.test(source)) return 'ICU plural/select messages require a message-format adapter.';
  if (/<\/?[a-zA-Z][^>]*>/.test(source)) return 'HTML messages require the DOM adapter or a parsed HTML integration.';
  if (/<\/?[a-zA-Z][^>]*>/.test(text)) return 'The provider added HTML to a plain-text translation.';
  if (!sameTokens(protectedTokens(source), protectedTokens(text))) return 'The translation changed a placeholder, URL, or email address.';
  if (!balancedMarkers(text)) return 'The translation misplaced a numbered rich-text marker.';
  if (preserveNumbers && !sameNumbers(source, text)) return 'The translation changed a numeric value.';
  for (const [term, replacement] of Object.entries(glossary)) {
    if (hasTerm(source, term) && !hasTerm(text, replacement, {ignoreCase: true})) return `The translation did not preserve the glossary term "${term}".`;
  }
  return null;
}

export function summarize(results, locale, issues = []) {
  const counts = Object.fromEntries(STATUS.map(status => [status, results.filter(r => r.status === status).length]));
  return {locale, total: results.length, translated: counts.translated, source: counts.source,
    missing: counts.missing, rejected: counts.rejected, errors: counts.error, needsReview: counts['needs-review'],
    unreviewed: results.filter(r => r.status === 'translated' && !r.reviewed).length,
    issues, segments: results};
}

export function createEngine({sourceLocale = 'en', provider, requireReviewed = false, glossary = {}, style = '', preserveNumbers = true, cacheSize = 2000, batchSize = 64} = {}) {
  sourceLocale = canonicalLocale(sourceLocale);
  if (!provider || typeof provider.translate !== 'function') throw new TypeError('A translation provider is required.');
  // A target-language style note for the translator, such as "Address the reader with du."
  if (typeof style !== 'string' || style.length > 500) throw new TypeError('style must be a string of at most 500 characters.');
  if (!Number.isInteger(cacheSize) || cacheSize < 0 || !Number.isInteger(batchSize) || batchSize < 1 || batchSize > 256) throw new TypeError('Invalid cache or batch size.');
  let policy;
  let epoch = 0;
  const cache = new Map();
  const setPolicy = (update = {}) => {
    const next = {...(policy ?? {requireReviewed: !!requireReviewed, glossary, preserveNumbers: !!preserveNumbers}), ...update};
    if (!next.glossary || typeof next.glossary !== 'object' || Array.isArray(next.glossary) || Object.entries(next.glossary).some(([k,v]) => !k || typeof v !== 'string' || !v)) throw new TypeError('Glossary entries must map nonempty terms to nonempty translations.');
    policy = Object.freeze({...next, glossary: Object.freeze({...next.glossary})});
    cache.clear(); epoch++;
  };
  setPolicy();
  const remember = (key, value, requestEpoch) => {
    if (!cacheSize || requestEpoch !== epoch) return;
    cache.delete(key); cache.set(key, value);
    while (cache.size > cacheSize) cache.delete(cache.keys().next().value);
  };
  return {
    sourceLocale, setPolicy,
    clearCache() { cache.clear(); epoch++; },
    async translate(segments, {locale, signal} = {}) {
      locale = canonicalLocale(locale);
      if (!Array.isArray(segments) || segments.length > 10000) throw new TypeError('Segments must be an array of at most 10,000 entries.');
      const ids = new Set();
      for (const s of segments) {
        if (!s || typeof s.id !== 'string' || !s.id || ids.has(s.id) || typeof s.source !== 'string' || s.source.length > 20000 || (s.context !== undefined && (typeof s.context !== 'string' || s.context.length > 2000)) || (s.kind !== undefined && typeof s.kind !== 'string')) throw new TypeError('Each segment needs a unique ID and bounded source/context text.');
        ids.add(s.id);
      }
      signal?.throwIfAborted();
      const requestPolicy = policy;
      const requestEpoch = epoch;
      const prepared = segments.map(s => {
        const source = s.source.trim();
        const leading = s.source.match(/^\s*/)[0];
        const trailing = source ? s.source.match(/\s*$/)[0] : '';
        return {s, source, leading, trailing, key: JSON.stringify([locale, source, s.context ?? '', s.kind ?? 'text'])};
      });
      const resolved = new Map();
      const pending = new Map();
      for (const p of prepared) {
        if (locale === sourceLocale || !p.source || !/\p{L}/u.test(p.source)) {
          resolved.set(p.key, {text: p.source, status: 'source', reviewed: true});
        } else if (cache.has(p.key)) {
          const result = cache.get(p.key); cache.delete(p.key); cache.set(p.key, result); resolved.set(p.key, result);
        } else if (!pending.has(p.key)) pending.set(p.key, p);
      }
      const work = [...pending.values()];
      for (let offset = 0; offset < work.length; offset += batchSize) {
        signal?.throwIfAborted();
        const batch = work.slice(offset, offset + batchSize);
        const request = batch.map((p, index) => ({id: `s${offset + index}`, source: p.source, context: p.s.context ?? '', kind: p.s.kind ?? 'text'}));
        let outputs;
        try {
          outputs = await provider.translate({sourceLocale, targetLocale: locale, segments: request, glossary: requestPolicy.glossary, ...(style ? {style} : {}), signal});
          signal?.throwIfAborted();
          if (!Array.isArray(outputs)) throw new TypeError('The provider response must be an array.');
          const outputIds = new Set();
          for (const output of outputs) {
            if (!output || typeof output.id !== 'string' || outputIds.has(output.id) || !request.some(s => s.id === output.id)) throw new TypeError('The provider returned duplicate or unknown IDs.');
            outputIds.add(output.id);
          }
        } catch (error) {
          if (signal?.aborted || error?.name === 'AbortError') throw error;
          for (const p of batch) resolved.set(p.key, {text: p.source, status: 'error', reviewed: false, reason: error?.userFacing ? error.message : 'Translation provider failed. Check the service and retry.'});
          continue;
        }
        const byId = new Map(outputs.map(o => [o.id, o]));
        batch.forEach((p,index) => {
          const output = byId.get(request[index].id);
          let result;
          if (!output) result = {text: p.source, status: 'missing', reviewed: false, reason: 'No translation is available for this text and context.'};
          else if (['missing','rejected','error','needs-review'].includes(output.status)) {
            result = {text:p.source, status:output.status, reviewed:false, reason:typeof output.reason === 'string' ? output.reason.slice(0,1000) : 'The service retained the source text.'};
          } else {
            const reason = validateTranslation(p.source, output.text, requestPolicy);
            if (reason) result = {text: p.source, status: 'rejected', reviewed: false, reason};
            else if (requestPolicy.requireReviewed && output.reviewed !== true) result = {text: p.source, status: 'needs-review', reviewed: false, candidate:output.text.trim(), reason: 'Approve this translation before displaying it.'};
            else result = {text: output.text.trim(), status: 'translated', reviewed: output.reviewed === true};
          }
          resolved.set(p.key, result);
          // Failed and missing results remain retryable when a provider recovers.
          if (result.status === 'translated') remember(p.key, result, requestEpoch);
        });
      }
      signal?.throwIfAborted();
      return prepared.map(p => {
        const result = resolved.get(p.key);
        return {...result, id: p.s.id, source: p.s.source,
          text: result.status === 'translated' ? p.leading + result.text + p.trailing : p.s.source};
      });
    }
  };
}
