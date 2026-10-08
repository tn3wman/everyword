import test from 'node:test';
import assert from 'node:assert/strict';
import {createTranslationServer} from '../src/server.js';
import {catalogProvider,httpProvider} from '../src/providers.js';
import {createEngine} from '../src/core.js';
import {inspectProject} from '../src/inspect.js';
import {diskCache} from '../src/disk-cache.js';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
async function withServer(t,options={}){
  const server=createTranslationServer({provider:catalogProvider({}),cacheStorage:false,...options});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
  return `http://127.0.0.1:${server.address().port}`;
}
const request=(body,headers={})=>({method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body)});

test('language choices require complete current-cache coverage and never generate translations',async t=>{
  const rows=new Map();let calls=0,version='model-v1';
  let manifest={sourceLocale:'en',segments:Array.from({length:260},(_,index)=>({id:`label-${index}`,source:`Label ${index}`,context:'App button'}))};
  const provider={cacheKey:()=>version,async translate({segments,targetLocale}){calls++;return segments.map(({id,source})=>({id,text:`${targetLocale}: ${source}`}));}};
  const storage={get:key=>rows.get(key),set:(key,value)=>rows.set(key,value),stats:()=>({persistent:true,entries:rows.size})};
  const url=await withServer(t,{provider,cacheStorage:storage,contentManifest:()=>manifest});
  const choices=()=>fetch(url+'/api/languages?locales=en,es,fr,ja').then(r=>r.json());
  assert.deepEqual((await choices()).locales,['en']);assert.equal(calls,0);
  for(const locale of ['es','fr'])for(let offset=0;offset<260;offset+=256){
    const segments=manifest.segments.slice(offset,Math.min(offset+256,locale==='fr'?259:260));
    await fetch(url+'/api/translate',request({targetLocale:locale,segments}));
  }
  const warmedCalls=calls;
  assert.deepEqual((await choices()).locales,['en','es']);
  await fetch(url+'/api/translate',request({targetLocale:'fr',segments:manifest.segments.slice(259)}));
  assert.deepEqual((await choices()).locales,['en','es','fr']);assert.equal(calls,warmedCalls+1);
  const writes=(await fetch(url+'/api/status').then(r=>r.json())).cache.writes;
  manifest={...manifest,segments:[...manifest.segments,{id:'new',source:'New label'}]};
  assert.deepEqual((await choices()).locales,['en']);
  manifest={...manifest,segments:manifest.segments.slice(0,-1)};
  version='model-v2';
  assert.deepEqual((await choices()).locales,['en']);assert.equal(calls,warmedCalls+1);
  const status=await fetch(url+'/api/status').then(r=>r.json());assert.equal(status.cache.writes,writes);
  version='model-v1';
  rows.delete([...rows.keys()].find(key=>JSON.parse(key)[2]==='es'));
  assert.deepEqual((await choices()).locales,['en','fr']);
  assert.equal(calls,warmedCalls+1);
});

test('language availability fails closed without a capture, storage, or valid cache records',async t=>{
  const manifest={sourceLocale:'en',segments:[{id:'one',source:'Hello {name}'}]};
  const provider={cacheKey:()=> 'never-infer',translate(){throw new Error('Availability must not infer');}};
  for(const options of [
    {contentManifest:undefined,cacheStorage:undefined},
    {contentManifest:manifest,cacheStorage:false},
    {contentManifest:manifest,cacheStorage:{get:()=>({text:'Lost token'}),set(){}}},
    {contentManifest:manifest,cacheStorage:{get(){throw new Error('database offline');},set(){}}},
    {contentManifest:{sourceLocale:'en',segments:[]},cacheStorage:undefined},
  ]){
    const url=await withServer(t,{provider,...options});
    assert.deepEqual(await fetch(url+'/api/languages?locales=es').then(r=>r.json()),{sourceLocale:'en',locales:['en']});
  }
  const url=await withServer(t,{provider,cacheStorage:undefined,contentManifest:manifest});
  assert.equal((await fetch(url+'/api/languages?locales=bad_locale')).status,400);
  assert.equal((await fetch(url+'/api/languages?locales='+Array(41).fill('es').join(','))).status,400);
});

test('real HTTP service validates translations, serves source fallback and recovers',async t=>{
  const url=await withServer(t,{provider:catalogProvider({es:{Hello:{text:'Hola',reviewed:true},'Hi {name}':'Hola'}})});
  const engine=createEngine({provider:httpProvider({endpoint:url+'/api/translate'})});
  const [ok,missing,bad]=await engine.translate([{id:'1',source:'Hello'},{id:'2',source:'Unknown'},{id:'3',source:'Hi {name}'}],{locale:'es'});
  assert.equal(ok.text,'Hola');assert.equal(ok.reviewed,true);assert.equal(missing.status,'missing');assert.equal(bad.text,'Hi {name}');
});

test('invalid requests, unexpected origins and static traversal cannot read arbitrary files',async t=>{
  const url=await withServer(t);
  const cases=[
    [request({targetLocale:'bad_locale',segments:[]}),400],
    [request({targetLocale:'es',segments:[{id:'a',source:3}]}),400],
    [request({targetLocale:'es',segments:[]},{Origin:'https://attacker.example'}),403],
    [{method:'POST',headers:{'Content-Type':'application/json'},body:'{broken'},400],
    [{method:'POST',body:'text'},415]
  ];
  for(const [options,status] of cases) assert.equal((await fetch(url+'/api/translate',options)).status,status);
  for(const path of ['/package.json','/src/%2e%2e/%2e%2e/%2e%2e/etc/passwd','/src/%xx']) assert.ok((await fetch(url+path)).status>=400);
  const status=await fetch(url+'/api/status').then(r=>r.json());assert.equal(status.mode,'configured model');
});

test('allowlisted web clients receive exact CORS permission',async t=>{
  const url=await withServer(t,{allowedOrigins:['https://app.example']});
  const r=await fetch(url+'/api/translate',request({targetLocale:'es',segments:[]},{Origin:'https://app.example'}));
  assert.equal(r.status,200);assert.equal(r.headers.get('access-control-allow-origin'),'https://app.example');
});

test('project inspector reads files without confusing inventory with runtime coverage',async()=>{
  const report=await inspectProject(new URL('../',import.meta.url).pathname);
  assert.ok(report.sourceFiles>5);assert.ok(!report.files.some(f=>f.includes('node_modules/')));
  assert.ok(report.gaps.some(g=>g.includes('visited')));
});

test('HTTP preserves rejection and service failure statuses for client recovery',async t=>{
  let failed=true;
  const provider={async translate({segments}){
    if(failed)throw new Error('not connected');
    return segments.map(s=>({id:s.id,text:s.source==='Hello'?'Hola':'Removed token'}));
  }};
  const url=await withServer(t,{provider});
  const engine=createEngine({provider:httpProvider({endpoint:url+'/api/translate'})});
  const input=[{id:'a',source:'Hello'},{id:'b',source:'Hello {name}'}];
  assert.ok((await engine.translate(input,{locale:'es'})).every(r=>r.status==='error'));
  failed=false;
  const result=await engine.translate(input,{locale:'es'});assert.equal(result[0].text,'Hola');assert.equal(result[1].status,'rejected');assert.equal(result[1].text,'Hello {name}');
});

test('automatic server cache survives a server restart and invalidates when the model changes',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'everyword-server-cache-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const path=join(directory,'cache.sqlite');let calls=0;
  const provider={cacheKey:()=> 'model-v1',async translate({segments}){calls++;return segments.map(({id})=>({id,text:'Hola',reviewed:false}));}};
  const first=await withServer(t,{provider,cacheStorage:diskCache({path})});
  const input={sourceLocale:'en',targetLocale:'es',segments:[{id:'one',source:'Hello',context:'Greeting'}]};
  assert.equal((await fetch(first+'/api/translate',request(input)).then(r=>r.json())).translations[0].text,'Hola');
  const second=await withServer(t,{provider:{cacheKey:()=> 'model-v1',translate(){throw new Error('Model must not be called');}},cacheStorage:diskCache({path})});
  const cached=await fetch(second+'/api/translate',request({...input,segments:[{...input.segments[0],id:'after-restart'}]})).then(r=>r.json());
  assert.equal(cached.translations[0].text,'Hola');assert.equal(cached.translations[0].id,'after-restart');assert.equal(cached.report.needsReview,0);
  const status=await fetch(second+'/api/status').then(r=>r.json());assert.equal(status.cache.hits,1);assert.equal(calls,1);
  const updated=await withServer(t,{provider:{cacheKey:()=> 'model-v2',async translate({segments}){calls++;return segments.map(({id})=>({id,text:'Saludos'}));}},cacheStorage:diskCache({path})});
  assert.equal((await fetch(updated+'/api/translate',request(input)).then(r=>r.json())).translations[0].text,'Saludos');assert.equal(calls,2);
});

test('an embedding app owns its async database and server shutdown does not close it',async t=>{
  let closed=false;const rows=new Map();
  const storage={async get(key){return rows.get(key);},async set(key,value){rows.set(key,value);},async stats(){return {entries:rows.size,persistent:true};},close(){closed=true;}};
  const url=await withServer(t,{provider:{cacheKey:()=> 'app-model',translate:async({segments})=>segments.map(({id})=>({id,text:'Hola'}))},cacheStorage:storage,cacheInfo:{type:'custom',location:'Application database'}});
  await fetch(url+'/api/translate',request({targetLocale:'es',segments:[{id:'one',source:'Hello'}]}));
  const status=await fetch(url+'/api/status').then(r=>r.json());assert.equal(status.cache.entries,1);assert.equal(status.cache.location,'Application database');assert.equal(status.cache.healthy,true);
  t.after(()=>assert.equal(closed,false));
});

test('HTTP cache-only mode serves prepared labels and never infers cold labels',async t=>{
  let calls=0;
  const provider={cacheKey:()=> 'cache-only-model',async translate({segments}){calls++;return segments.map(({id})=>({id,text:'Hola'}));}};
  const url=await withServer(t,{provider,cacheStorage:undefined});
  const prepared={sourceLocale:'en',targetLocale:'es',segments:[{id:'warm',source:'Hello'}]};
  assert.equal((await fetch(url+'/api/translate',request(prepared))).status,200);assert.equal(calls,1);
  const body=await fetch(url+'/api/translate',request({...prepared,cacheOnly:true,segments:[{id:'hit',source:'Hello'},{id:'cold',source:'Goodbye'}]})).then(r=>r.json());
  assert.deepEqual(body.translations,[{id:'hit',text:'Hola',reviewed:false}]);
  assert.equal(body.report.missing,1);assert.equal(body.report.segments[1].reason,'This label has not been prepared in the selected language.');assert.equal(calls,1);
  const status=await fetch(url+'/api/status').then(r=>r.json());assert.equal(status.cache.hits,1);assert.equal(status.cache.misses,2);
});

test('HTTP cache-only validation and storage-free mode fail closed',async t=>{
  let calls=0;
  const url=await withServer(t,{provider:{translate(){calls++;throw new Error('Inference must not run');}},cacheStorage:false});
  const base={targetLocale:'es',segments:[{id:'cold',source:'Hello'}]};
  assert.equal((await fetch(url+'/api/translate',request({...base,cacheOnly:'yes'}))).status,400);
  const response=await fetch(url+'/api/translate',request({...base,cacheOnly:true}));
  const body=await response.json();assert.equal(response.status,200);assert.equal(body.report.missing,1);assert.equal(calls,0);
});
