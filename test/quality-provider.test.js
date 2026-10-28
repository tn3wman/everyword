import assert from 'node:assert/strict';
import test from 'node:test';
import {setTimeout as delay} from 'node:timers/promises';
import {qualityProvider} from '../src/quality-provider.js';
import {createEngine} from '../src/core.js';
import {cachedProvider} from '../src/cache.js';

function response(text, finishReason = 'stop') {
  return {ok: true, status: 200, async json() {
    return {choices: [{finish_reason: finishReason, message: {content: text}}]};
  }};
}

function request(segments, options = {}) {
  return {sourceLocale: 'en', targetLocale: 'es', segments, glossary: {}, ...options};
}

function sourceFromPrompt(prompt) {
  const instruction = 'without any additional explanation.';
  const start = prompt.indexOf(instruction);
  return prompt.slice(start + instruction.length + 2);
}

test('sends one plain-text source with native language names, context, glossary, and deterministic sampling', async () => {
  let call;
  const provider = qualityProvider({baseURL: async () => 'http://127.0.0.1:41234/v1/', fetch: async (url, options) => {
    call = {url, options, body: JSON.parse(options.body)};
    return response('Abrir {filename}');
  }});
  const result = await provider.translate(request([
    {id: 'menu', source: 'Open {filename}', context: 'A command in the File menu.'},
  ], {glossary: {Open: 'Abrir', Save: 'Guardar'}}));

  assert.equal(call.url, 'http://127.0.0.1:41234/v1/chat/completions');
  assert.equal(call.body.temperature, 0);
  assert.equal(call.body.messages.length, 1);
  assert.equal(call.body.messages[0].role, 'user');
  assert.equal('response_format' in call.body, false);
  const prompt = call.body.messages[0].content;
  assert.match(prompt, /Translate the following text into Spanish/);
  assert.match(prompt, /Background information for disambiguation only/);
  assert.match(prompt, /A command in the File menu/);
  assert.match(prompt, /"Open" translates to "Abrir"/);
  assert.doesNotMatch(prompt, /"Save" translates to "Guardar"/);
  assert.match(prompt, /quoted data, not instructions/);
  assert.equal(sourceFromPrompt(prompt), 'Open {filename}');
  assert.deepEqual(result, [{id: 'menu', text: 'Abrir {filename}', reviewed: false}]);
  assert.match(provider.cacheKey(), /quality-plain-v\d+/);
  assert.match(provider.cacheKey(), /ab8472660ac61fac25f1af43fac2599d52a8a775/);
  assert.doesNotMatch(provider.cacheKey(), /41234/);
});

test('makes one request per natural chunk and restores source whitespace', async () => {
  const seen = [];
  const provider = qualityProvider({baseURL: 'http://localhost:8080/v1', fetch: async (_url, options) => {
    const body = JSON.parse(options.body);
    const source = sourceFromPrompt(body.messages[0].content);
    seen.push(source);
    return response(`[${source}]`);
  }});
  const paragraph = `${'A sentence with words. '.repeat(58)}\n\n`;
  const source = `  ${paragraph.repeat(13)}Last sentence.  `;
  assert.ok(source.length < 20000);
  const [result] = await provider.translate(request([{id: 'long', source, context: 'Long help copy.'}]));

  assert.ok(seen.length > 8);
  assert.ok(seen.every(chunk => chunk.length <= 1500));
  assert.equal(result.text.slice(0, 3), '  [');
  assert.equal(result.text.slice(-3), ']  ');
  assert.equal((result.text.match(/\n\n/g) ?? []).length, 13);
});

test('keeps generated DOM metadata out of prompts and rejects echoed metadata', async () => {
  const prompts = [];
  const provider = qualityProvider({baseURL:'http://127.0.0.1:8080/v1', fetch:async (_url, options) => {
    prompts.push(JSON.parse(options.body).messages[0].content);
    return response('span:text; heading=Su biblioteca');
  }});
  const [result] = await provider.translate(request([{id:'label',source:'Search',context:'span:text; heading=Your library'}]));
  assert.doesNotMatch(prompts[0], /span:text|heading=Your library/);
  assert.equal(result.status, 'rejected');
  assert.equal(result.text, 'Search');
  assert.match(result.reason, /echoed internal context/);
});

test('limits all requests through one provider instance to four active calls', async () => {
  let active = 0, maximum = 0, calls = 0;
  const provider = qualityProvider({baseURL: 'http://127.0.0.1:8080/v1', fetch: async (_url, options) => {
    active++; calls++; maximum = Math.max(maximum, active);
    await delay(5, undefined, {signal: options.signal});
    active--;
    return response(sourceFromPrompt(JSON.parse(options.body).messages[0].content));
  }});
  const makeSegments = prefix => Array.from({length: 7}, (_, index) => ({id: `${prefix}${index}`, source: `Text ${index}`}));
  await Promise.all([
    provider.translate(request(makeSegments('a'))),
    provider.translate(request(makeSegments('b'))),
  ]);
  assert.equal(calls, 14);
  assert.equal(maximum, 4);
});

test('rejects unknown languages with a safe user-facing error before fetching', async () => {
  let fetched = false;
  const provider = qualityProvider({baseURL: 'http://127.0.0.1:8080/v1', fetch: async () => { fetched = true; }});
  await assert.rejects(
    provider.translate(request([{id: 'one', source: 'Hello'}], {targetLocale: 'zz'})),
    error => error.code === 'unsupported-language' && error.userFacing === true && /zz/.test(error.message),
  );
  assert.equal(fetched, false);
});

test('rejects duplicate caller IDs and non-loopback endpoints before fetching', async () => {
  let fetched = false;
  const local = qualityProvider({baseURL: 'http://127.0.0.1:8080/v1', fetch: async () => { fetched = true; }});
  await assert.rejects(local.translate(request([
    {id: 'same', source: 'First'},
    {id: 'same', source: 'Second'},
  ])), /IDs must be unique/);
  const remote = qualityProvider({baseURL: 'https://models.example.com/v1', fetch: async () => { fetched = true; }});
  await assert.rejects(remote.translate(request([{id: 'one', source: 'Hello'}], {targetLocale: 'zh-Hant'})), /loopback/);
  assert.equal(fetched, false);
});

test('retains unsafe source text while successful neighbors still translate', async t => {
  const cases = [
    ['truncated', response('Hola {name}, 42.', 'length'), /truncated/],
    ['empty', response('   '), /invalid translation text/],
    ['changed placeholder', response('Hola {nombre}, 42.'), /changed a placeholder/],
    ['changed number', response('Hola {name}, 43.'), /changed a numeric value/],
  ];
  for (const [name, mockResponse, pattern] of cases) await t.test(name, async () => {
    const provider = qualityProvider({baseURL: 'http://[::1]:8080/v1', fetch: async (_url, options) => {
      const source = sourceFromPrompt(JSON.parse(options.body).messages[0].content);
      return source === 'Safe neighbor' ? response('Vecino seguro') : mockResponse;
    }});
    const result = await provider.translate(request([{id: 'one', source: 'Hello {name}, 42.'}, {id: 'safe', source: 'Safe neighbor'}]));
    assert.deepEqual(result[0], {id: 'one', text: 'Hello {name}, 42.', status: 'rejected', reason: result[0].reason, reviewed: false});
    assert.match(result[0].reason, pattern);
    assert.deepEqual(result[1], {id: 'safe', text: 'Vecino seguro', reviewed: false});
  });
  const provider = qualityProvider({baseURL: 'http://127.0.0.1:8080/v1', fetch: async () => response("Archivo',")});
  const [result] = await provider.translate(request([{id: 'file', source: 'File'}]));
  assert.equal(result.text, "Archivo',");
});

test('retries one numeric preservation failure with explicit literal requirements', async () => {
  const prompts = [];
  const provider = qualityProvider({baseURL: 'http://127.0.0.1:8080/v1', fetch: async (_url, options) => {
    const prompt = JSON.parse(options.body).messages[0].content;
    prompts.push(prompt);
    return response(prompts.length === 1 ? 'Mi espacio de trabajo 1' : 'Mi espacio de trabajo');
  }});
  const [result] = await provider.translate(request([{id: 'workspace', source: 'My workspace'}]));
  assert.deepEqual(result, {id: 'workspace', text: 'Mi espacio de trabajo', reviewed: false});
  assert.equal(prompts.length, 2);
  assert.doesNotMatch(prompts[0], /previous result|spelled-out numbers/);
  assert.match(prompts[1], /Keep spelled-out numbers spelled out/);
  assert.match(prompts[1], /must not contain numeric digits/);
});

test('keeps the first protection failure when both retries are also unsafe, sampling the last', async () => {
  const temperatures = [];
  const provider = qualityProvider({baseURL: 'http://127.0.0.1:8080/v1', fetch: async (_url, options) => {
    temperatures.push(JSON.parse(options.body).temperature);
    return response(temperatures.length === 1 ? 'Hola {nombre}, 42.' : 'Hola {name}, 43.');
  }});
  const [result] = await provider.translate(request([{id: 'one', source: 'Hello {name}, 42.'}]));
  assert.deepEqual(temperatures, [0, 0, 0.5]);
  assert.equal(result.status, 'rejected');
  assert.match(result.reason, /changed a placeholder/);
});

test('does not retry unrelated parse failures', async () => {
  let calls = 0;
  const provider = qualityProvider({baseURL: 'http://127.0.0.1:8080/v1', fetch: async () => {
    calls++;
    return response('span:text; heading=Su biblioteca');
  }});
  const [result] = await provider.translate(request([{id: 'label', source: 'Search'}]));
  assert.equal(calls, 1);
  assert.equal(result.status, 'rejected');
  assert.match(result.reason, /echoed internal context/);
});

test('reports HTTP and network failures per segment', async () => {
  const provider = qualityProvider({baseURL: 'http://127.0.0.1:8080/v1', fetch: async (_url, options) => {
    const source = sourceFromPrompt(JSON.parse(options.body).messages[0].content);
    if (source === 'HTTP fails') return {ok: false, status: 503};
    if (source === 'Network fails') throw new Error('socket closed');
    return response('Funciona');
  }});
  const result = await provider.translate(request([
    {id: 'http', source: 'HTTP fails'}, {id: 'network', source: 'Network fails'}, {id: 'good', source: 'Works'},
  ]));
  assert.equal(result[0].status, 'error');
  assert.match(result[0].reason, /HTTP 503/);
  assert.equal(result[1].status, 'error');
  assert.match(result[1].reason, /socket closed/);
  assert.deepEqual(result[2], {id: 'good', text: 'Funciona', reviewed: false});
});

test('one rejected chunk retains its whole segment without losing other segments', async () => {
  const long = `${'Good sentence. '.repeat(105)}Count 42. ${'Ending sentence. '.repeat(105)}`;
  let calls = 0;
  const provider = qualityProvider({baseURL: 'http://127.0.0.1:8080/v1', fetch: async (_url, options) => {
    calls++;
    const source = sourceFromPrompt(JSON.parse(options.body).messages[0].content);
    if (source.includes('Count 42')) return response(source.replace('42', '43'));
    if (source === 'Separate label') return response('Etiqueta separada');
    return response(`[${source}]`);
  }});
  const result = await provider.translate(request([{id: 'long', source: long}, {id: 'label', source: 'Separate label'}]));
  assert.ok(calls >= 4);
  assert.equal(result[0].text, long);
  assert.equal(result[0].status, 'rejected');
  assert.match(result[0].reason, /numeric value/);
  assert.deepEqual(result[1], {id: 'label', text: 'Etiqueta separada', reviewed: false});
});

test('mixed cached results retry only the rejected segment and recover', async () => {
  const calls = [];
  let repaired = false;
  const quality = qualityProvider({baseURL: 'http://127.0.0.1:8080/v1', fetch: async (_url, options) => {
    const source = sourceFromPrompt(JSON.parse(options.body).messages[0].content);
    calls.push(source);
    if (source === 'Count 42' && !repaired) return response('Cuenta 43');
    return response(source === 'Hello' ? 'Hola' : 'Cuenta 42');
  }});
  const cached = cachedProvider(quality);
  const segments = [{id: 'hello', source: 'Hello'}, {id: 'count', source: 'Count 42'}];
  const first = await createEngine({provider: cached}).translate(segments, {locale: 'es'});
  assert.deepEqual(first.map(({status}) => status), ['translated', 'rejected']);
  repaired = true;
  const second = await createEngine({provider: cached}).translate(segments, {locale: 'es'});
  assert.deepEqual(second.map(({text, status}) => [text, status]), [['Hola', 'translated'], ['Cuenta 42', 'translated']]);
  assert.deepEqual(calls, ['Hello', 'Count 42', 'Count 42', 'Count 42', 'Count 42']);
});

test('propagates request cancellation to active calls and removes queued work', async () => {
  const controller = new AbortController();
  let calls = 0, notifyStarted;
  const started = new Promise(resolve => { notifyStarted = resolve; });
  const provider = qualityProvider({baseURL: 'http://127.0.0.1:8080/v1', timeoutMs: 1000, fetch: async (_url, options) => {
    calls++;
    if (calls === 4) notifyStarted();
    return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), {once: true}));
  }});
  const pending = provider.translate(request([{id: 'long', source: 'Sentence. '.repeat(1800)}], {signal: controller.signal}));
  await started;
  controller.abort(new DOMException('Canceled by test.', 'AbortError'));
  await assert.rejects(pending, error => error.name === 'AbortError');
  assert.equal(calls, 4);
});

test('repairs mistyped placeholder braces and drops a period the label never had', async () => {
  const replies = {'Remove {name}': 'Entferne {name>.', 'Pay what you want.': 'Zahle, was du willst.'};
  const provider = qualityProvider({baseURL: 'http://127.0.0.1:41234/v1', fetch: async (url, options) =>
    response(replies[sourceFromPrompt(JSON.parse(options.body).messages[0].content)])});
  const result = await provider.translate(request([
    {id: 'a', source: 'Remove {name}'}, {id: 'b', source: 'Pay what you want.'},
  ], {targetLocale: 'de'}));
  assert.deepEqual(result.map(r => r.text), ['Entferne {name}', 'Zahle, was du willst.']);
});

test('retries a translation that left out a required glossary term', async () => {
  const prompts = [];
  const provider = qualityProvider({baseURL: 'http://127.0.0.1:41234/v1', fetch: async (url, options) => {
    prompts.push(JSON.parse(options.body).messages[0].content);
    return response(prompts.length === 1 ? '在展示地层的海报上' : '在地层海报上');
  }});
  const glossary = {Strata: '地层', Contours: '等高线'};
  const [first] = await provider.translate(request([{id: 'a', source: 'On the Strata poster'}], {targetLocale: 'zh-CN', glossary}));
  assert.equal(first.text, '在展示地层的海报上');
  assert.equal(prompts.length, 1);
  prompts.length = 0;
  let replies = ['在海报上', '在地层海报上'];
  const retrying = qualityProvider({baseURL: 'http://127.0.0.1:41234/v1', fetch: async (url, options) => {
    prompts.push(JSON.parse(options.body).messages[0].content);
    return response(replies.shift());
  }});
  const [second] = await retrying.translate(request([{id: 'a', source: 'On the Strata poster'}], {targetLocale: 'zh-CN', glossary}));
  assert.equal(second.text, '在地层海报上');
  assert.match(prompts[1], /Use each required translation below exactly as written/);
  assert.doesNotMatch(prompts[0], /Contours/);
});

test('rejects a translation that copies background context the source lacks', async () => {
  let calls = 0;
  const provider = qualityProvider({baseURL: 'http://127.0.0.1:8080/v1', fetch: async () => {
    calls++;
    return response(calls < 3 ? 'Auf dem Poster von Printed Canyon' : 'Auf dem Strata-Poster');
  }});
  const [result] = await provider.translate(request([{id: 'a', source: 'On the Strata poster', context: 'Website text for Printed Canyon.'}], {targetLocale: 'de'}));
  assert.equal(result.text, 'Auf dem Strata-Poster');
  assert.equal(calls, 3);
});

test('retries a translation whose rich-text markers are out of order', async () => {
  const replies = ['Lee </0>los términos<0>', 'Lee <0>los términos</0>'];
  const provider = qualityProvider({baseURL: 'http://127.0.0.1:8080/v1', fetch: async () => response(replies.shift())});
  const [result] = await provider.translate(request([{id: 'a', source: 'Read <0>the terms</0>'}]));
  assert.equal(result.text, 'Lee <0>los términos</0>');
});

test('a retry the model server refuses reports an error, not an unsafe translation', async () => {
  let calls = 0;
  const provider = qualityProvider({baseURL: 'http://127.0.0.1:8080/v1', fetch: async () =>
    ++calls === 1 ? response('Hola {nombre}') : {ok: false, status: 503}});
  const [result] = await provider.translate(request([{id: 'a', source: 'Hello {name}'}]));
  assert.equal(result.status, 'error');
  assert.match(result.reason, /HTTP 503/);
});

test('retries output that adds a greeting or echoes the prompt, and frames the style note as guidance', async () => {
  const prompts = [];
  const provider = qualityProvider({baseURL: 'http://127.0.0.1:8080/v1', fetch: async (_url, options) => {
    prompts.push(JSON.parse(options.body).messages[0].content);
    return response(prompts.length === 1 ? 'Hey du, hier ist die Übersetzung – alle Platzhalter bleiben erhalten.' : 'Text');
  }});
  const [result] = await provider.translate({...request([{id: 'label', source: 'Text'}]), style: 'Address the reader informally with du.'});
  assert.deepEqual(result, {id: 'label', text: 'Text', reviewed: false});
  assert.match(prompts[0], /for your guidance only: Address the reader informally with du\. Never add a greeting/);
});

test('keeps an abbreviation expanded in translation', async () => {
  const provider = qualityProvider({baseURL: 'http://127.0.0.1:8080/v1', fetch: async () => response('अक्सर पूछे जाने वाले प्रश्न')});
  const [result] = await provider.translate({...request([{id: 'faq', source: 'FAQ'}]), targetLocale: 'hi'});
  assert.deepEqual(result, {id: 'faq', text: 'अक्सर पूछे जाने वाले प्रश्न', reviewed: false});
});

test('translates a passage sentence by sentence when the whole passage keeps dropping a figure', async () => {
  const source = 'It rises to 4,478 meters (14,692 feet). The north face overlooks Zermatt.';
  const sources = [];
  const provider = qualityProvider({baseURL: 'http://127.0.0.1:8080/v1', fetch: async (_url, options) => {
    const text = sourceFromPrompt(JSON.parse(options.body).messages[0].content);
    sources.push(text);
    if (text === source) return response('Er erreicht 4.478 Meter. Die Nordwand blickt auf Zermatt.');
    return response(text.startsWith('It rises') ? 'Er erreicht 4.478 Meter (14.692 Fuß).' : 'Die Nordwand blickt auf Zermatt.');
  }});
  const [result] = await provider.translate({...request([{id: 'peak', source}]), targetLocale: 'de'});
  assert.deepEqual(result, {id: 'peak', text: 'Er erreicht 4.478 Meter (14.692 Fuß). Die Nordwand blickt auf Zermatt.', reviewed: false});
  assert.deepEqual(sources.filter(text => text !== source), ['It rises to 4,478 meters (14,692 feet).', 'The north face overlooks Zermatt.']);
});

test('joins Chinese sentences without the source spaces, and reports a sentence that still fails', async () => {
  const provider = qualityProvider({baseURL: 'http://127.0.0.1:8080/v1', fetch: async (_url, options) => {
    const text = sourceFromPrompt(JSON.parse(options.body).messages[0].content);
    return response({'Founded in 1934. It is large.': '成立。很大。', 'Founded in 1934.': '成立于1934年。', 'It is large.': '它很大。', 'Wait 5 days. Then go.': '等。走。', 'Wait 5 days.': '等几天。', 'Then go.': '然后走。'}[text]);
  }});
  const [ok, bad] = await provider.translate({...request([{id: 'park', source: 'Founded in 1934. It is large.'}, {id: 'wait', source: 'Wait 5 days. Then go.'}]), targetLocale: 'zh-CN'});
  assert.deepEqual(ok, {id: 'park', text: '成立于1934年。它很大。', reviewed: false});
  assert.equal(bad.status, 'rejected');
  assert.equal(bad.text, 'Wait 5 days. Then go.');
});

test('puts the required term in place of a product name the model left in English', async () => {
  const provider = qualityProvider({baseURL: 'http://127.0.0.1:8080/v1', fetch: async () => response('<0>Ridgeline</0> चुनें।')});
  const [result] = await provider.translate({...request([{id: 'pick', source: 'Choose <0>Ridgeline</0>.'}]), targetLocale: 'hi', glossary: {Ridgeline: 'पर्वत-रेखाएँ'}});
  assert.deepEqual(result, {id: 'pick', text: '<0>पर्वत-रेखाएँ</0> चुनें।', reviewed: false});
});

test('sentence fallback never splits a URL and validates the joined passage', async () => {
  const source = 'Read https://example.com/foo?x=Hello. Wait 5 days.';
  const sources = [];
  const provider = qualityProvider({baseURL: 'http://127.0.0.1:8080/v1', fetch: async (_url, options) => {
    const text = sourceFromPrompt(JSON.parse(options.body).messages[0].content);
    sources.push(text);
    if (text === source) return response('Lies https://example.com/foo?x=Hello. Warte Tage.');
    return response({'Read https://example.com/foo?x=Hello.': 'Lies https://example.com/foo?x=Hello.', 'Wait 5 days.': 'Warte 5 Tage.'}[text]);
  }});
  const [result] = await provider.translate({...request([{id: 'url', source}]), targetLocale: 'de'});
  assert.deepEqual(result, {id: 'url', text: 'Lies https://example.com/foo?x=Hello. Warte 5 Tage.', reviewed: false});
  assert.ok(!sources.includes('x=Hello.'));
});

test('term enforcement leaves a URL that contains the term intact', async () => {
  const provider = qualityProvider({baseURL: 'http://127.0.0.1:8080/v1', fetch: async () => response('Wähle Ridgeline unter https://example.com/Ridgeline.')});
  const [result] = await provider.translate({...request([{id: 'pick', source: 'Choose Ridgeline at https://example.com/Ridgeline.'}]), targetLocale: 'de', glossary: {Ridgeline: 'Kammlinie'}});
  assert.deepEqual(result, {id: 'pick', text: 'Wähle Kammlinie unter https://example.com/Ridgeline.', reviewed: false});
});

test('a malformed model response is an error, not a rejected translation', async () => {
  for (const reply of [{ok: true, json: async () => ({})}, {ok: true, json: async () => ({choices: [{finish_reason: 'length', message: {}}]})}, {ok: true, json: async () => { throw new SyntaxError('Unexpected token'); }}]) {
    const provider = qualityProvider({baseURL: 'http://127.0.0.1:8080/v1', fetch: async () => reply});
    const [result] = await provider.translate(request([{id: 'line', source: 'Create a map of your favorite place.'}]));
    assert.equal(result.status, 'error');
    assert.equal(result.text, 'Create a map of your favorite place.');
  }
});

test('a short label that absorbs its context is retried, then rejected; real short labels pass', async () => {
  const translate = async (source, context, replies, targetLocale = 'de') => {
    let call = 0;
    const provider = qualityProvider({baseURL: 'http://127.0.0.1:8080/v1', fetch: async () => response(replies[Math.min(call++, replies.length - 1)])});
    const [result] = await provider.translate({...request([{id: 'label', source, context}]), targetLocale});
    return {result, calls: call};
  };
  const hint = 'elevation gain, the total climb of a route';
  assert.equal((await translate('Gain', hint, ['海拔上升高度，即总爬升量', '爬升'], 'zh-CN')).result.text, '爬升');
  const exhausted = await translate('Streams', 'small rivers on a map', ['arroyos y riachuelos dibujados en un mapa'], 'es');
  assert.equal(exhausted.result.status, 'rejected');
  assert.equal(exhausted.calls, 3);
  assert.equal((await translate('portrait', 'page orientation', ['Porträtorichtung, höher als breit'])).result.status, 'rejected');
  assert.equal((await translate('Gain', hint, ['海拔上升高度即总爬升量是多少'], 'zh-CN')).result.status, 'rejected');
  // Accepted; the final-period cleanup separately trims its last dot.
  assert.equal((await translate('For example', 'a phrase', ['z. B.'])).result.status, undefined);
  assert.deepEqual((await translate('Orientation', 'page orientation', ['横向、纵向'], 'zh-CN')).result, {id: 'label', text: '横向、纵向', reviewed: false});
  assert.deepEqual((await translate('Settings', 'application preferences', ['การตั้งค่า'], 'th')).result, {id: 'label', text: 'การตั้งค่า', reviewed: false});
  const required = qualityProvider({baseURL: 'http://127.0.0.1:8080/v1', fetch: async () => response('纬度，经度')});
  const [coordinates] = await required.translate({...request([{id: 'c', source: 'Coordinates', context: 'map coordinate display'}]), targetLocale: 'zh-CN', glossary: {Coordinates: '纬度，经度'}});
  assert.deepEqual(coordinates, {id: 'c', text: '纬度，经度', reviewed: false});
  const cased = qualityProvider({baseURL: 'http://127.0.0.1:8080/v1', fetch: async () => response('latitud, longitud')});
  const [lower] = await cased.translate({...request([{id: 'c', source: 'Coordinates', context: 'map coordinate display'}]), glossary: {Coordinates: 'Latitud, longitud'}});
  assert.deepEqual(lower, {id: 'c', text: 'latitud, longitud', reviewed: false});
});

test('a translation using a word the style avoids is retried with that word named, then rejected', async () => {
  const prompts = [];
  const provider = qualityProvider({baseURL: 'http://127.0.0.1:8080/v1', fetch: async (_url, options) => {
    prompts.push(JSON.parse(options.body).messages[0].content);
    return response(prompts.length === 1 ? 'Speichern Sie Ihre Dateien' : 'Speichere deine Dateien');
  }});
  const [result] = await provider.translate({...request([{id: 'save', source: 'Save your files'}]), targetLocale: 'de', avoid: ['Sie', 'Ihre']});
  assert.deepEqual(result, {id: 'save', text: 'Speichere deine Dateien', reviewed: false});
  assert.match(prompts[1], /Do not use these words: "Sie", "Ihre"\./);
  const stubborn = qualityProvider({baseURL: 'http://127.0.0.1:8080/v1', fetch: async () => response('Speichern Sie Ihre Dateien')});
  const [rejected] = await stubborn.translate({...request([{id: 'save', source: 'Save your files'}]), targetLocale: 'de', avoid: ['Sie']});
  assert.equal(rejected.status, 'rejected');
  assert.match(rejected.reason, /"Sie", which the style avoids/);
});
