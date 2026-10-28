import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {translateCatalog, glossaryFor} from '../src/catalog.js';

async function project(source, existing = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'everyword-catalog-'));
  await writeFile(join(directory, 'en.json'), JSON.stringify(source));
  for (const [locale, catalog] of Object.entries(existing)) await writeFile(join(directory, `${locale}.json`), JSON.stringify(catalog));
  return {directory, source: join(directory, 'en.json'), output: locale => join(directory, `${locale}.json`), read: async locale => JSON.parse(await readFile(join(directory, `${locale}.json`), 'utf8'))};
}

const entries = (...texts) => Object.fromEntries(texts.map(text => [text, text]));

test('translates only new keys, keeps valid translations, drops removed keys and keeps source order', async () => {
  const files = await project(entries('Save', 'Open {name}', ' × '), {es: {Save: 'Guardar', Removed: 'Eliminado', 'Open {name}': 'Abrir'}});
  const requests = [];
  const provider = {async translate(request) {
    requests.push(request);
    return request.segments.map(segment => ({id: segment.id, text: `${request.targetLocale}:${segment.source}`}));
  }};
  const report = await translateCatalog({source: files.source, locales: ['es', 'en', 'fr'], output: files.output, provider});
  // The stale "Abrir" lost its placeholder, so it is translated again; " × " has no letters.
  assert.deepEqual(requests.map(request => [request.targetLocale, request.segments.map(segment => segment.source)]).sort(),
    [['es', ['Open {name}']], ['fr', ['Save', 'Open {name}']]]);
  assert.deepEqual(Object.entries(await files.read('es')), [['Save', 'Guardar'], ['Open {name}', 'es:Open {name}'], [' × ', ' × ']]);
  assert.deepEqual(await files.read('fr'), {Save: 'fr:Save', 'Open {name}': 'fr:Open {name}', ' × ': ' × '});
  assert.equal(report.ready, true);
  assert.deepEqual(report.locales.map(({locale, reused, translated}) => [locale, reused, translated]), [['es', 1, 2], ['fr', 0, 3]]);
});

test('leaves unsafe translations out, reports them, and retries them on the next run', async () => {
  const files = await project(entries('Read the <0>terms</0>.', 'About 1,670 m', 'Printed Canyon posters'));
  let attempt = 0;
  const provider = {async translate({segments}) {
    attempt++;
    return segments.map(segment => ({id: segment.id, text: attempt === 1
      ? {'Read the <0>terms</0>.': 'Lee los términos.', 'About 1,670 m': 'Unos 1.680 m', 'Printed Canyon posters': 'Pósteres de Cañón Impreso'}[segment.source]
      : {'Read the <0>terms</0>.': 'Lee los <0>términos</0>.', 'About 1,670 m': 'Unos 1.670 m', 'Printed Canyon posters': 'Pósteres de Printed Canyon'}[segment.source]}));
  }};
  const glossaries = {'*': {'Printed Canyon': 'Printed Canyon'}};
  const first = await translateCatalog({source: files.source, locales: ['es'], output: files.output, provider, glossaries});
  assert.equal(first.ready, false);
  assert.deepEqual(first.locales[0].failures.map(failure => failure.status), ['rejected', 'rejected', 'rejected']);
  assert.deepEqual(await files.read('es'), {});
  const second = await translateCatalog({source: files.source, locales: ['es'], output: files.output, provider, glossaries});
  assert.equal(second.ready, true);
  assert.equal((await files.read('es'))['About 1,670 m'], 'Unos 1.670 m');
});

test('refuses ID-keyed catalogs, whose changed source text would keep a stale translation', async () => {
  const files = await project({'checkout.title': 'Checkout'});
  await assert.rejects(translateCatalog({source: files.source, locales: ['es'], output: files.output, provider: {translate: async () => []}}), /source text/);
});

test('locale glossaries extend and override the shared one', () => {
  const glossaries = {'*': {Strata: 'Strata', Poster: 'Poster'}, de: {Poster: 'Poster (de)'}, 'zh-CN': {Strata: '地层'}};
  assert.deepEqual(glossaryFor(glossaries, 'de'), {Strata: 'Strata', Poster: 'Poster (de)'});
  assert.deepEqual(glossaryFor(glossaries, 'zh-CN'), {Strata: '地层', Poster: 'Poster'});
});

test('each locale gets its own style note, which the provider receives', async () => {
  const files = await project(entries('Choose a file'));
  const styles = {};
  const provider = {async translate(request) {
    styles[request.targetLocale] = request.style;
    return request.segments.map(segment => ({id: segment.id, text: `${request.targetLocale} text`}));
  }};
  await translateCatalog({source: files.source, locales: ['de', 'fr', 'es'], output: files.output, provider,
    styles: {de: 'Address the reader with du.', fr: 'Address the reader with vous.'}});
  assert.deepEqual(styles, {de: 'Address the reader with du.', fr: 'Address the reader with vous.', es: undefined});
});

test('checks every locale before inference, and a failing locale stops the others before returning', async () => {
  const files = await project(entries('Save', 'Open'));
  let calls = 0;
  const idle = {async translate() { calls++; return []; }};
  await assert.rejects(translateCatalog({source: files.source, locales: ['es', 'de'], output: files.output, provider: idle, styles: {de: 'x'.repeat(501)}}), /style/);
  assert.equal(calls, 0);
  let release, spanishSettled = false;
  const gate = new Promise(resolve => { release = resolve; });
  const provider = {async translate({targetLocale, segments, signal}) {
    if (targetLocale === 'de') { release(); return segments.map(segment => ({id: segment.id, text: 'de text'})); }
    await gate;
    // Spanish waits on the model until the German failure aborts it.
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => { spanishSettled = true; reject(signal.reason); }, {once: true}));
  }};
  const onProgress = ({locale}) => { if (locale === 'de') throw new Error('progress sink failed'); };
  await assert.rejects(translateCatalog({source: files.source, locales: ['es', 'de'], output: files.output, provider, onProgress}), /progress sink failed/);
  assert.equal(spanishSettled, true);
  await assert.rejects(readFile(files.output('es')), {code: 'ENOENT'});
});

test('a message context wins over the global one, and inherited keys are not contexts', async () => {
  const files = await project(entries('Right', 'constructor', 'Save'));
  const seen = {};
  const provider = {async translate({segments}) {
    for (const segment of segments) seen[segment.source] = segment.context;
    return segments.map(segment => ({id: segment.id, text: `es ${segment.source}`}));
  }};
  await translateCatalog({source: files.source, locales: ['es'], output: files.output, provider, context: 'an app', contexts: {Right: 'the right-hand page margin', Save: ''}});
  assert.deepEqual(seen, {Right: 'the right-hand page margin', constructor: 'an app', Save: 'an app'});
  await assert.rejects(translateCatalog({source: files.source, locales: ['es'], output: files.output, provider, contexts: {Right: 3}}), /contexts must map/);
});
