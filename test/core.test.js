import test from 'node:test';
import assert from 'node:assert/strict';
import {createEngine,validateTranslation,localeDirection} from '../src/core.js';
import {catalogProvider,modelProvider,httpProvider,fallbackProvider} from '../src/providers.js';
const seg = (source,context='screen',id='a') => ({id,source,context});

test('preserves whitespace, interpolations, and numbers; context chooses meaning',async()=>{
  const engine=createEngine({provider:catalogProvider({es:{'Count {count}: 12':'Cantidad {count}: 12','billing\u0004Charge':'Cobrar','battery\u0004Charge':'Carga'}})});
  const results=await engine.translate([seg('  Count {count}: 12\n','screen','a'),seg('Charge','billing','b'),seg('Charge','battery','c')],{locale:'es'});
  assert.deepEqual(results.map(r=>r.text),['  Cantidad {count}: 12\n','Cobrar','Carga']);
  assert.ok(results.every(r=>r.status==='translated'&&!r.reviewed));
});

test('validation refuses placeholder, number, address, glossary and ICU corruption',()=>{
  for(const [source,target] of [['Hi {name}','Hola'],['Cost: 19','Costo: 20'],['See https://example.com','Ver https://other.com'],['Send to a@example.com','Enviar a b@example.com'],['%1$s items','%2$s elementos'],['{{user}} has ${count}','{{user}} tiene ${total}'],['{n, plural, one {item} other {items}}','artículos']]) assert.ok(validateTranslation(source,target));
  assert.ok(validateTranslation('Keep Everyword','Mantén otra marca',{glossary:{Everyword:'Everyword'}}));
  assert.equal(validateTranslation('Total: 12','المجموع: ١٢'),null);
  assert.equal(validateTranslation('Newspaper','Periódico',{glossary:{New:'Nuevo'}}),null);
});

test('never claims review; strict mode retains source until catalog approval',async()=>{
  const catalog={es:{Hello:{text:'Hola',reviewed:false}}};
  const engine=createEngine({provider:catalogProvider(catalog),requireReviewed:true});
  assert.equal((await engine.translate([seg('Hello')],{locale:'es'}))[0].status,'needs-review');
  catalog.es.Hello.reviewed=true;
  assert.equal((await engine.translate([seg('Hello')],{locale:'es'}))[0].text,'Hola');
});

test('missing, rejected and provider errors keep exact source and recover on retry',async()=>{
  let phase='missing';
  const engine=createEngine({provider:{async translate({segments}){
    if(phase==='error') throw new Error('secret detail');
    if(phase==='missing') return [];
    return segments.map(s=>({id:s.id,text:phase==='rejected'?'Changed {x}':'Hola {name}'}));
  }}});
  for(const expected of ['missing','rejected','error']){
    phase=expected;
    const [r]=await engine.translate([seg(' Hello {name} ')],{locale:'es'});
    assert.equal(r.status,expected);assert.equal(r.text,' Hello {name} ');assert.ok(!r.reason.includes('secret'));
  }
  phase='ok';assert.equal((await engine.translate([seg(' Hello {name} ')],{locale:'es'}))[0].text,' Hola {name} ');
});

test('deduplicates contextual text, batches requests and isolates caches by context and language',async()=>{
  const batches=[];
  const engine=createEngine({batchSize:2,provider:{async translate(r){batches.push(r);return r.segments.map(s=>({id:s.id,text:`${r.targetLocale} ${s.source}`}));}}});
  const input=[seg('One','a','1'),seg('One','a','2'),seg('One','b','3'),seg('Two','b','4')];
  await engine.translate(input,{locale:'es'});assert.deepEqual(batches.map(b=>b.segments.length),[2,1]);
  await engine.translate(input,{locale:'es'});assert.equal(batches.length,2);
  await engine.translate(input,{locale:'fr'});assert.equal(batches.length,4);
  engine.setPolicy({requireReviewed:true});
  const out=await engine.translate(input,{locale:'es'});assert.ok(out.every(r=>r.status==='needs-review'));
});

test('invalid provider IDs fail closed, input IDs must be unique, source language needs no provider',async()=>{
  const engine=createEngine({provider:{async translate(){return [{id:'s0',text:'Hola'},{id:'s0',text:'Duplicada'}];}}});
  assert.equal((await engine.translate([seg('Hello')],{locale:'es'}))[0].status,'error');
  await assert.rejects(engine.translate([seg('One'),seg('Two')],{locale:'es'}),TypeError);
  await assert.rejects(engine.translate([seg('Hello')],{locale:'invalid_locale'}),RangeError);
  assert.equal((await engine.translate([seg('Hello')],{locale:'en'}))[0].status,'source');
});

test('aborted results cannot populate cache, cache policy change invalidates in-flight writes',async()=>{
  let finish;let calls=0;
  const engine=createEngine({provider:{translate({segments}){calls++;return new Promise(resolve=>finish=()=>resolve(segments.map(s=>({id:s.id,text:'Hola'}))));}}});
  const controller=new AbortController();
  const pending=engine.translate([seg('Hello')],{locale:'es',signal:controller.signal});
  controller.abort();finish();await assert.rejects(pending,{name:'AbortError'});
  const next=engine.translate([seg('Hello')],{locale:'es'});finish();await next;assert.equal(calls,2);
  engine.clearCache();
  const old=engine.translate([seg('Hello')],{locale:'es'});engine.setPolicy({requireReviewed:true});finish();await old;
  const latest=engine.translate([seg('Hello')],{locale:'es'});finish();assert.equal((await latest)[0].status,'needs-review');
});

test('model provider sends context and strips provider review assertions',async()=>{
  let sent;
  const provider=modelProvider({model:'local-model',fetch:async(url,request)=>{
    sent={url,request};return Response.json({choices:[{message:{content:JSON.stringify({translations:[{id:'a',text:'Hola',reviewed:true}]})}}]});
  }});
  const output=await provider.translate({sourceLocale:'en',targetLocale:'es',segments:[seg('Hello')],glossary:{}});
  assert.equal(output[0].reviewed,false);
  assert.match(sent.url,/127.0.0.1:11434\/v1\/chat\/completions/);
  const body=JSON.parse(sent.request.body);assert.equal(JSON.parse(body.messages[1].content).segments[0].context,'screen');
});

test('HTTP and fallback providers translate only unresolved entries',async()=>{
  const request={targetLocale:'es',sourceLocale:'en',segments:[seg('Hello','screen','a'),seg('Bye','screen','b')]};
  const fallback=fallbackProvider(catalogProvider({es:{Hello:'Hola'}}),httpProvider({fetch:async(url,opts)=>{
    const r=JSON.parse(opts.body);assert.equal(r.segments.length,1);return Response.json({translations:[{id:'b',text:'Adiós'}]});
  }}));
  assert.deepEqual((await fallback.translate(request)).map(r=>r.text),['Hola','Adiós']);
  assert.equal(localeDirection('ar'),'rtl');assert.equal(localeDirection('en'),'ltr');
});

test('HTTP provider opts into cache-only requests without changing default bodies',async()=>{
  const bodies=[];
  const fetch=async(url,options)=>{bodies.push(JSON.parse(options.body));return Response.json({translations:[]});};
  const input={targetLocale:'es',sourceLocale:'en',segments:[seg('Hello')],glossary:{}};
  await httpProvider({fetch}).translate(input);
  await httpProvider({fetch,cacheOnly:true}).translate(input);
  assert.equal(Object.hasOwn(bodies[0],'cacheOnly'),false);assert.equal(bodies[1].cacheOnly,true);
});

test('plain-text translation cannot introduce markup or rewrite an HTML message body',()=>{
  assert.ok(validateTranslation('Hello','<img src=x onerror=alert(1)>Hola'));
  assert.ok(validateTranslation('<p>Hello</p>','<p>Hola</p>'));
  assert.equal(validateTranslation('Use a < b in the formula','Usa a < b en la fórmula'),null);
});

test('numbered rich-text markers are protected and must stay balanced', () => {
  assert.equal(validateTranslation('Read the <0>terms</0> and <1/>.', 'Lee <1/> y los <0>términos</0>.'), null);
  assert.ok(validateTranslation('Read the <0>terms</0>.', 'Lee los términos.'));
  assert.ok(validateTranslation('Read the <0>terms</0>.', 'Lee los </0>términos<0>.'));
  assert.ok(validateTranslation('<0>A</0> <1>B</1>', '<0>A <1>B</0></1>'));
});

test('numbers compare across scripts, grouping and decimal separators', () => {
  for (const [source, text] of [
    ['About 1,670 m', 'Etwa 1.670 m'], ['About 1,670 m', '约1670米'], ['0.12 to 0.16 mm', '0,12 bis 0,16 mm'],
    ['522,427 acres', '5,22,427 एकड़'], ['Height 8,726 feet', 'ऊंचाई ८,७२६ फीट'], ['1 670 m', '1 670 m'],
  ]) assert.equal(validateTranslation(source, text), null, `${source} -> ${text}`);
  for (const [source, text] of [['About 1,670 m', 'Etwa 1.680 m'], ['18 × 24 inches', '18 × 42 Zoll'], ['Height 8,726', 'ऊंचाई ८,७२७']]) {
    assert.ok(validateTranslation(source, text), `${source} -> ${text}`);
  }
});

test('glossary source terms match whole words case-sensitively', () => {
  const glossary = {Contours: 'Contours'};
  assert.ok(validateTranslation('Choose Contours', 'Elige Curvas', {glossary}));
  assert.equal(validateTranslation('Trace the contours', 'Traza las curvas', {glossary}), null);
  assert.equal(validateTranslation('Choose Contours', 'Elige contours', {glossary}), null);
});

test('glossary terms match inside scripts written without spaces', () => {
  assert.equal(validateTranslation('On the Strata poster', '在展示地层的海报上', {glossary: {Strata: '地层'}}), null);
  assert.equal(validateTranslation('Printed Canyon uses it', 'Printed Canyon使用它', {glossary: {'Printed Canyon': 'Printed Canyon'}}), null);
  assert.ok(validateTranslation('Choose Strata', 'Choose Stratagem', {glossary: {Strata: 'Strata'}}));
  assert.equal(validateTranslation('A (B) C', 'x (B) y', {glossary: {'(B)': '(B)'}}), null);
});

test('glossary terms may contain regular expression punctuation', () => {
  assert.equal(validateTranslation('A 3D Terrain Model.', 'Ein 3D-Geländemodell.', {glossary: {'3D Terrain Model': '3D-Geländemodell'}}), null);
  assert.equal(validateTranslation('Use a/b now', 'Usa a/b ya', {glossary: {'a/b': 'a/b'}}), null);
});

test('dates may write a named month as its number', () => {
  assert.equal(validateTranslation('Founded on April 12, 1929.', '成立于1929年4月12日。'), null);
  assert.ok(validateTranslation('Founded on April 12, 1929.', '成立于1929年5月12日。'));
  assert.ok(validateTranslation('Founded in 1929.', '成立于1929年4月。'));
});
