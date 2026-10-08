import {canonicalLocale} from './core.js';

const MAX_CANDIDATE_LOCALES = 40;

function candidateLocales(locales) {
  if (locales === undefined) return undefined;
  if (!Array.isArray(locales) || locales.length > MAX_CANDIDATE_LOCALES) {
    throw new TypeError('locales must be an array of at most 40 language codes');
  }
  return [...new Set(locales.map(canonicalLocale))];
}

function languagesEndpoint(endpoint, locales) {
  if (locales === undefined) return endpoint;
  const separator = endpoint.includes('?') ? '&' : '?';
  return `${endpoint}${separator}locales=${encodeURIComponent(locales.join(','))}`;
}

function abortError(signal) {
  if (signal?.reason !== undefined) return signal.reason;
  return new DOMException('The operation was aborted.', 'AbortError');
}

/** Return the languages whose current content is already prepared by the server. */
export async function availableLocales({
  endpoint = '/api/languages',
  locales,
  sourceLocale = 'en',
  fetch: fetchImpl = globalThis.fetch,
  timeoutMs = 3000,
  signal,
} = {}) {
  const source = canonicalLocale(sourceLocale);
  const candidates = candidateLocales(locales);
  if (typeof fetchImpl !== 'function') throw new TypeError('fetch must be a function');
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw new TypeError('timeoutMs must be a nonnegative number');
  signal?.throwIfAborted();
  if (candidates?.length === 0) return [source];

  const timeoutController = new AbortController();
  const requestSignal = signal
    ? AbortSignal.any([signal, timeoutController.signal])
    : timeoutController.signal;
  let timer;
  let removeAbortListener;
  const timedOut = new Promise((_, reject) => {
    timer = setTimeout(() => {
      timeoutController.abort(new DOMException('The readiness request timed out.', 'TimeoutError'));
      reject(timeoutController.signal.reason);
    }, timeoutMs);
  });
  const callerAborted = signal && new Promise((_, reject) => {
    const rejectAbort = () => reject(abortError(signal));
    signal.addEventListener('abort', rejectAbort, {once: true});
    removeAbortListener = () => signal.removeEventListener('abort', rejectAbort);
  });

  try {
    const request = (async () => {
      const response = await fetchImpl(languagesEndpoint(endpoint, candidates), {
        method: 'GET',
        headers: {Accept: 'application/json'},
        signal: requestSignal,
      });
      if (!response?.ok) throw new Error('The readiness service was unavailable.');
      return response.json();
    })();
    const body = await Promise.race([request, timedOut, ...(callerAborted ? [callerAborted] : [])]);
    if (!body || typeof body !== 'object' || Array.isArray(body) || !Array.isArray(body.locales)
      || body.locales.length > MAX_CANDIDATE_LOCALES + 1) {
      throw new TypeError('The readiness service returned an invalid response.');
    }
    if (canonicalLocale(body.sourceLocale) !== source) {
      throw new TypeError('The readiness service returned a different source language.');
    }
    const allowed = candidates && new Set(candidates);
    const result = [source];
    for (const value of body.locales) {
      const locale = canonicalLocale(value);
      if (locale !== source && (!allowed || allowed.has(locale)) && !result.includes(locale)) result.push(locale);
    }
    return result;
  } catch (error) {
    if (signal?.aborted) throw abortError(signal);
    return [source];
  } finally {
    clearTimeout(timer);
    removeAbortListener?.();
  }
}
