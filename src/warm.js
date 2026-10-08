import {canonicalLocale, createEngine, summarize} from './core.js';

function counts(results, locale) {
  const {segments, ...report}=summarize(results,locale);
  return report;
}

/** Populate the configured provider's cache before visitors need these strings. */
export async function warmTranslations({provider, sourceLocale='en', locales, segments, onProgress, signal}={}) {
  sourceLocale=canonicalLocale(sourceLocale);
  if(!Array.isArray(locales)||!locales.length)throw new TypeError('Choose at least one language to prepare.');
  locales=[...new Set(locales.map(canonicalLocale))];
  const engine=createEngine({sourceLocale,provider,cacheSize:0});
  // Validate the entire capture before making any provider calls or writes.
  await engine.translate(segments,{locale:sourceLocale,signal});
  const reports={};
  for(const locale of locales){
    const results=[];
    for(let offset=0;offset<segments.length;offset+=64){
      signal?.throwIfAborted();
      results.push(...await engine.translate(segments.slice(offset,offset+64),{locale,signal}));
      await onProgress?.({...counts(results,locale),completed:results.length,total:segments.length});
    }
    reports[locale]=counts(results,locale);
  }
  const ready=Object.values(reports).every(report=>!report.errors&&!report.missing&&!report.rejected&&!report.needsReview);
  return {sourceLocale,total:segments.length,ready,locales:reports};
}
