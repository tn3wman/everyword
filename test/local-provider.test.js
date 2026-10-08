import assert from 'node:assert/strict';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {localProvider} from '../src/local-provider.js';
import {createEngine} from '../src/core.js';
import {setTimeout as delay} from 'node:timers/promises';

const workerPath = fileURLToPath(new URL('./fixtures/local-worker.js', import.meta.url));

function createProvider(t, options = {}) {
  const provider = localProvider({
    python: process.execPath,
    workerPath,
    timeoutMs: 1000,
    ...options,
  });
  t.after(() => provider.close());
  return provider;
}

function request(segments, options = {}) {
  return {
    sourceLocale: 'en',
    targetLocale: 'es',
    segments,
    ...options,
  };
}

test('returns automatic novel translations without claiming review', async t => {
  const provider = createProvider(t);
  const [result]=await createEngine({provider}).translate([{id:'novel',source:'A sentence never seen before'}],{locale:'es'});
  assert.equal(result.text,'Una frase nunca vista antes');
  assert.equal(result.status,'translated');
  assert.equal(result.reviewed,false);
});

test('batches duplicate source strings once and fans the result back to every ID', async t => {
  const provider = createProvider(t);
  const results = await provider.translate(request([
    {id: 'first', source: 'Repeat me'},
    {id: 'second', source: 'Repeat me'},
    {id: 'third', source: 'Something else'},
  ]));
  assert.deepEqual(results, [
    {id: 'first', text: 'es:Repeat me:batch=2', reviewed: false},
    {id: 'second', text: 'es:Repeat me:batch=2', reviewed: false},
    {id: 'third', text: 'es:Something else:batch=2', reviewed: false},
  ]);
});

test('repairs model output that changes placeholders and numbers', async t => {
  const provider = createProvider(t);
  const [result] = await provider.translate(request([
    {id: 'protected', source: 'Hello {name}, you have 42 notes.'},
  ]));
  assert.deepEqual(result, {
    id: 'protected',
    text: 'Hola {name}, tienes 42 notas.',
    reviewed: false,
  });
});

test('surfaces unsupported languages as safe user-facing errors', async t => {
  const provider = createProvider(t);
  await assert.rejects(
    provider.translate(request([{id: 'one', source: 'Hello'}], {targetLocale: 'zz'})),
    error => error.code === 'unsupported-language'
      && error.userFacing === true
      && /unavailable/.test(error.message),
  );
});

test('cancellation does not poison the worker for the next request', async t => {
  const provider = createProvider(t);
  const controller = new AbortController();
  const slow = provider.translate(request([{id: 'slow', source: 'SLOW'}], {signal: controller.signal}));
  const rejected=assert.rejects(slow,error=>error.name==='AbortError');
  for(let attempt=0;attempt<100&&!provider.status().loading;attempt++)await delay(5);
  assert.equal(provider.status().loading?.target,'es');
  controller.abort();
  await rejected;

  const results = await provider.translate(request([{id: 'next', source: 'Still works'}], {targetLocale: 'fr'}));
  assert.deepEqual(results, [{id: 'next', text: 'fr:Still works:batch=1', reviewed: false}]);
});

test('close rejects future translation requests', async () => {
  const provider = localProvider({python: process.execPath, workerPath, timeoutMs: 100});
  await provider.start();
  provider.close();
  await assert.rejects(
    provider.translate(request([{id: 'after-close', source: 'Hello'}])),
    /stopped|closed/i,
  );
});


test('retries an unchanged menu noun without rewriting ordinary brand copy', async t=>{
  const provider=createProvider(t);const engine=createEngine({provider});
  const [menu]=await engine.translate([{id:'menu',source:'File',kind:'menu-label'}],{locale:'es'});
  assert.equal(menu.text,'Archivo');assert.equal(menu.status,'translated');
  const [brand]=await engine.translate([{id:'brand',source:'File',kind:'text'}],{locale:'es'});
  assert.equal(brand.text,'File');
});
