import test from 'node:test';
import assert from 'node:assert/strict';
import {availableLocales} from '../src/readiness.js';

function response(body, {ok = true} = {}) {
  return {ok, async json() { return body; }};
}

test('returns canonical prepared languages and sends configured candidates', async () => {
  let request;
  const locales = await availableLocales({
    endpoint: '/languages?project=site',
    sourceLocale: 'en-us',
    locales: ['ES', 'fr', 'es'],
    fetch: async (url, options) => {
      request = {url, options};
      return response({sourceLocale: 'en-US', locales: ['fr', 'en-US', 'es', 'de', 'ES']});
    },
  });
  assert.deepEqual(locales, ['en-US', 'fr', 'es']);
  assert.equal(request.url, '/languages?project=site&locales=es%2Cfr');
  assert.equal(request.options.method, 'GET');
  assert.equal(request.options.headers.Accept, 'application/json');
});

test('omits the candidate query so the server can use configured support', async () => {
  let url;
  const locales = await availableLocales({
    fetch: async (value) => {
      url = value;
      return response({sourceLocale: 'en', locales: ['en', 'pt-BR']});
    },
  });
  assert.equal(url, '/api/languages');
  assert.deepEqual(locales, ['en', 'pt-BR']);
});

test('falls back to the source language after network and malformed responses', async () => {
  const cases = [
    async () => { throw new Error('offline'); },
    async () => response({}, {ok: false}),
    async () => response({sourceLocale: 'en', locales: 'es'}),
    async () => response({sourceLocale: 'fr', locales: ['es']}),
    async () => response({sourceLocale: 'bad_locale', locales: ['es']}),
    async () => response({sourceLocale: 'en', locales: ['bad_locale']}),
    async () => ({ok: true, async json() { throw new SyntaxError('bad JSON'); }}),
  ];
  for (const fetch of cases) {
    assert.deepEqual(await availableLocales({sourceLocale: 'EN-us', fetch}), ['en-US']);
  }
});

test('validates and bounds candidate languages before making a request', async () => {
  let calls = 0;
  const fetch = async () => { calls += 1; return response({sourceLocale: 'en', locales: ['en']}); };
  await assert.rejects(availableLocales({locales: 'es', fetch}), /array of at most 40/);
  await assert.rejects(availableLocales({locales: ['bad_locale'], fetch}), RangeError);
  await assert.rejects(availableLocales({locales: Array.from({length: 41}, () => 'es'), fetch}), /at most 40/);
  assert.deepEqual(await availableLocales({locales: [], fetch}), ['en']);
  assert.equal(calls, 0);
});

test('propagates caller aborts', async () => {
  const controller = new AbortController();
  const pending = availableLocales({
    signal: controller.signal,
    fetch: async () => new Promise(() => {}),
  });
  controller.abort(new DOMException('Canceled by caller.', 'AbortError'));
  await assert.rejects(pending, {name: 'AbortError', message: 'Canceled by caller.'});
});

test('bounds both the response and JSON phases with one timeout', async () => {
  const never = () => new Promise(() => {});
  const started = Date.now();
  assert.deepEqual(await availableLocales({timeoutMs: 15, fetch: never}), ['en']);
  assert.ok(Date.now() - started < 500);
  assert.deepEqual(await availableLocales({
    timeoutMs: 15,
    fetch: async () => ({ok: true, json: never}),
  }), ['en']);
});
