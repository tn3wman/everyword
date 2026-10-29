import {mkdir, readFile, rename, writeFile} from 'node:fs/promises';
import {dirname} from 'node:path';
import {canonicalLocale, createEngine, validateTranslation} from './core.js';

const BATCH = 64;

async function readJSON(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT' && fallback !== undefined) return fallback; throw error; }
}

function plainCatalog(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.values(value).some(text => typeof text !== 'string')) {
    throw new TypeError(`${label} must be a JSON object of strings.`);
  }
  return value;
}

// Readers never see a partially written catalog.
async function writeAtomically(path, value) {
  await mkdir(dirname(path), {recursive: true});
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
  await rename(temporary, path);
}

/**
 * A marker whose source text is itself a catalog message names that interface label ("select
 * <1>Go</1>"), so its translated text becomes the label's translation ("<1>Los</1>"). The result is
 * kept only if it still passes validation. Words around the marker are not adjusted, so a language
 * that inflects or elides before a name (French "l'aide" → "l'Support") can read awkwardly.
 */
export function alignLabels(source, text, translations, policy = {}) {
  let aligned = text;
  // A marker number used twice cannot be matched to one occurrence, so it is left alone.
  const counts = new Map();
  for (const [, marker] of source.matchAll(/<(\d+)>/g)) counts.set(marker, (counts.get(marker) ?? 0) + 1);
  for (const [, marker, label] of source.matchAll(/<(\d+)>([^<]+)<\/\1>/g)) {
    if (counts.get(marker) > 1 || (text.match(new RegExp(`<${marker}>`, 'g')) ?? []).length !== 1) continue;
    const translation = translations.get(label);
    if (typeof translation !== 'string' || translation === label) continue;
    aligned = aligned.replace(new RegExp(`<${marker}>[^<]*</${marker}>`), () => `<${marker}>${translation}</${marker}>`);
  }
  return aligned === text || validateTranslation(source, aligned, policy) ? text : aligned;
}

/** Glossary file: {"*": {term: translation}, "<locale>": {...}}; locale entries override "*". */
export function glossaryFor(glossaries, locale) {
  const language = new Intl.Locale(locale).language;
  return {...glossaries['*'], ...glossaries[language], ...glossaries[locale]};
}

/**
 * Style file: {"<locale>": "Address the reader with du."} or {"<locale>": {"note": "…", "avoid":
 * ["Sie", "Ihr"]}}; the most specific entry wins. A translation that uses an avoided word the source
 * does not is retried, then left out.
 */
function styleEntry(styles, locale) {
  return styles[locale] ?? styles[new Intl.Locale(locale).language] ?? styles['*'] ?? '';
}
export function styleFor(styles, locale) {
  const entry = styleEntry(styles, locale);
  return typeof entry === 'string' ? entry : entry.note ?? '';
}
export function avoidFor(styles, locale) {
  const entry = styleEntry(styles, locale);
  return typeof entry === 'string' ? [] : entry.avoid ?? [];
}
/** Words to steer away from with a retry, kept when the model insists (German "Sie" for du). */
export function discourageFor(styles, locale) {
  const entry = styleEntry(styles, locale);
  return typeof entry === 'string' ? [] : entry.discourage ?? [];
}

/**
 * Translate a source-keyed catalog ({"Save": "Save"}, as Lingui and gettext extract it) into one
 * file per locale. Existing translations of current keys are kept, so only new source text reaches
 * the provider; keys no longer in the source are dropped. Each batch is written as it completes,
 * so an interrupted run resumes where it stopped. Entries the provider cannot translate safely stay
 * absent, and the report lists them.
 */
export async function translateCatalog({source, locales, output, provider, sourceLocale = 'en', glossaries = {}, styles = {}, context, contexts = {}, onProgress, signal}) {
  const catalog = plainCatalog(await readJSON(source), source);
  for (const [key, text] of Object.entries(catalog)) {
    if (key !== text) throw new TypeError(`Catalog keys must be their source text, so a changed source is a new entry. "${key.slice(0, 80)}" differs from its value.`);
  }
  if (typeof output !== 'function') throw new TypeError('Set output to a function from locale to file path.');
  if (!contexts || typeof contexts !== 'object' || Array.isArray(contexts) || Object.values(contexts).some(value => typeof value !== 'string')) {
    throw new TypeError('contexts must map messages to context strings.');
  }
  // Own keys only: a message named "constructor" must not pick up Object.prototype.constructor.
  const contextOf = key => Object.hasOwn(contexts, key) && contexts[key] ? contexts[key] : context;
  sourceLocale = canonicalLocale(sourceLocale);
  const keys = Object.keys(catalog);
  const targets = [...new Set(locales.map(canonicalLocale))].filter(locale => locale !== sourceLocale);
  // Check every locale's files and settings before any inference starts.
  const jobs = await Promise.all(targets.map(async locale => {
    const path = output(locale);
    const glossary = glossaryFor(glossaries, locale);
    const engine = createEngine({sourceLocale, provider, glossary, style: styleFor(styles, locale), avoid: avoidFor(styles, locale), discourage: discourageFor(styles, locale), cacheSize: 0, batchSize: BATCH});
    return {locale, path, glossary, engine, existing: plainCatalog(await readJSON(path, {}), path)};
  }));
  // Locales share the provider, so its concurrency limit stays saturated across batch boundaries.
  // One locale's failure stops the others, and none is still writing when this returns or throws.
  const stop = new AbortController();
  const running = signal ? AbortSignal.any([signal, stop.signal]) : stop.signal;
  const settled = await Promise.allSettled(jobs.map(async ({locale, path, glossary, engine, existing}) => {
    const translated = new Map();
    for (const key of keys) {
      // A kept translation must still meet the style: one using an avoided word is translated again.
      if (typeof existing[key] === 'string' && !validateTranslation(key, existing[key], {glossary, sourceLocale, avoid: avoidFor(styles, locale)})) translated.set(key, existing[key]);
    }
    const work = keys.filter(key => !translated.has(key));
    const failures = [];
    const policy = {glossary, sourceLocale, avoid: avoidFor(styles, locale)};
    const save = () => writeAtomically(path, Object.fromEntries(keys.flatMap(key => translated.has(key) ? [[key, alignLabels(key, translated.get(key), translated, policy)] ] : [])));
    for (let offset = 0; offset < work.length; offset += BATCH) {
      running.throwIfAborted();
      const batch = work.slice(offset, offset + BATCH);
      // A message's own context ("Right": "the right-hand page margin") disambiguates a short label.
      const results = await engine.translate(batch.map((key, index) => ({id: `m${offset + index}`, source: key, ...(contextOf(key) ? {context: contextOf(key)} : {})})), {locale, signal: running});
      results.forEach((result, index) => {
        // Text without letters (" × ", "1.") is its own translation.
        if (['translated', 'source'].includes(result.status)) translated.set(batch[index], result.text);
        else failures.push({source: batch[index], status: result.status, reason: result.reason});
      });
      await save();
      onProgress?.({locale, completed: Math.min(offset + BATCH, work.length), total: work.length, failed: failures.length});
    }
    if (!work.length) await save();
    return {locale, total: keys.length, reused: keys.length - work.length, translated: work.length - failures.length, failures};
  }).map(job => job.catch(error => { stop.abort(error); throw error; })));
  const failed = settled.find(result => result.status === 'rejected');
  if (failed) throw signal?.aborted ? signal.reason : failed.reason;
  const reports = settled.map(result => result.value);
  return {sourceLocale, total: keys.length, ready: reports.every(report => !report.failures.length), locales: reports};
}
