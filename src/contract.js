/**
 * Engine contract shared by adapters.
 *
 * createEngine({sourceLocale='en', provider, requireReviewed=false, glossary={}})
 * engine.translate(segments, {locale, signal}) -> Promise<Result[]>
 * engine.setPolicy({requireReviewed, glossary}) updates validation and clears cache.
 * engine.sourceLocale is canonical source language.
 * engine.clearCache() clears translations.
 *
 * Segment: {id: string, source: string, context?: string, kind?: string}
 * Result: {id, source, text, status, reviewed: boolean, reason?: string}
 * Status: source | translated | missing | rejected | error | needs-review
 * Missing/rejected/error/needs-review retain exact source text.
 * Provider: {translate({sourceLocale,targetLocale,segments,glossary,signal}) -> Promise<[{id,text,reviewed?:boolean}]>}
 * Provider receives trimmed source, core restores surrounding whitespace.
 * AbortSignal rejection uses AbortError and must not be swallowed.
 * Batch IDs are unique, nonempty strings. Plain text only; never render as HTML.
 */
export {};
