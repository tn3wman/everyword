import test from 'node:test';
import assert from 'node:assert/strict';
import {cachedProvider,browserCache} from '../src/cache.js';
import {createEngine} from '../src/core.js';

const store=()=>{const data=new Map();return {getItem:key=>data.get(key),setItem:(key,value)=>data.set(key,value)};};
const request=(source='Hello',extra={})=>({sourceLocale:'en',targetLocale:'es',segments:[{id:'one',source}],...extra});

test('generated results survive browser cache recreation and bypass inference',async()=>{
  const storage=store();let calls=0;
  const provider={async translate({segments}){calls++;return segments.map(({id})=>({id,text:'Hola',reviewed:false}));}};
  const first=cachedProvider(provider,{storage:browserCache({storage}),version:'model-v1'});
  await first.translate(request());
  const reopened=cachedProvider({translate(){throw new Error('Inference must not run');}},{storage:browserCache({storage}),version:'model-v1'});
  const result=await createEngine({provider:reopened}).translate([{id:'different',source:'Hello'}],{locale:'es'});
  assert.equal(result[0].text,'Hola');assert.equal(result[0].status,'translated');assert.equal(result[0].reviewed,false);
  assert.equal(calls,1);assert.equal(reopened.cacheStats().hits,1);
});

test('changed content, language, context, glossary, kind and model invalidate the cache',async()=>{
  let calls=0,version='v1';
  const cached=cachedProvider({async translate({segments}){calls++;return segments.map(({id,source})=>({id,text:source}));}},{version:()=>version});
  await cached.translate(request());await cached.translate(request());assert.equal(calls,1);
  await cached.translate(request('Goodbye'));
  await cached.translate(request('Hello',{targetLocale:'fr'}));
  await cached.translate(request('Hello',{segments:[{id:'two',source:'Hello',context:'menu'}]}));
  await cached.translate(request('Hello',{segments:[{id:'two',source:'Hello',kind:'menu-label'}]}));
  await cached.translate(request('Hello',{glossary:{Hello:'Hello'}}));
  version='v2';await cached.translate(request());assert.equal(calls,7);
});

test('failures, missing translations and broken placeholders remain retryable',async()=>{
  let calls=0;
  const cached=cachedProvider({async translate({segments}){calls++;if(calls===1)throw new Error('offline');if(calls===2)return [];return segments.map(({id})=>({id,text:calls===3?'Hola':'Hola {name}'}));}});
  await assert.rejects(cached.translate(request('Hello {name}')),/offline/);
  assert.deepEqual(await cached.translate(request('Hello {name}')),[]);
  await cached.translate(request('Hello {name}'));
  await cached.translate(request('Hello {name}'));
  assert.equal((await cached.translate(request('Hello {name}')))[0].text,'Hola {name}');assert.equal(calls,4);
});

test('unavailable or corrupt browser storage still translates and stays bounded',async()=>{
  const storage={getItem(){return '{bad';},setItem(){throw new Error('quota');}};
  const cache=browserCache({storage,maxEntries:2,maxBytes:100});
  const cached=cachedProvider({async translate({segments}){return segments.map(({id})=>({id,text:'Hola'}));}},{storage:cache});
  assert.equal((await cached.translate(request()))[0].text,'Hola');
  cache.set('a',{text:'x'.repeat(100)});cache.flush();assert.ok(cache.stats().bytes<=100);
  for(const key of ['a','b','c'])cache.set(key,{text:'x'});cache.flush();assert.ok(cache.stats().entries<=2);
});

test('malformed duplicate IDs cannot poison subsequent valid translations',async()=>{
  let broken=true,calls=0;
  const cached=cachedProvider({async translate(){calls++;return broken?[{id:'one',text:'Wrong'},{id:'one',text:'Wrong'}]:[{id:'one',text:'Hola'}];}});
  await assert.rejects(cached.translate(request()),/duplicate/);broken=false;
  assert.equal((await cached.translate(request()))[0].text,'Hola');assert.equal(calls,2);
});

test('cache-only requests return mixed hits and explicit misses without inference',async()=>{
  let calls=0;
  const cached=cachedProvider({async translate({segments}){calls++;return segments.map(({id})=>({id,text:'Hola'}));}});
  await cached.translate(request());
  const result=await cached.translate(request('Hello',{cacheOnly:true,segments:[{id:'hit',source:'Hello'},{id:'cold',source:'Goodbye'}]}));
  assert.deepEqual(result,[
    {id:'hit',text:'Hola',reviewed:false},
    {id:'cold',status:'missing',reason:'This label has not been prepared in the selected language.'}
  ]);
  assert.equal(calls,1);
  const stats=cached.cacheStats();
  assert.deepEqual({hits:stats.hits,misses:stats.misses,writes:stats.writes,storageErrors:stats.storageErrors},{hits:1,misses:2,writes:1,storageErrors:0});
  assert.equal(stats.entries,1);assert.equal(stats.persistent,false);assert.equal(stats.healthy,true);
});

test('cache-only storage failures and invalid records fail closed and preserve aborts',async()=>{
  let calls=0;
  const broken=cachedProvider({translate(){calls++;throw new Error('Inference must not run');}},{storage:{
    async get(key){if(key.includes('Invalid'))return {text:'Changed 12'};throw new Error('unavailable');},
    set(){throw new Error('Inference must not write');},
    stats(){return {entries:1,persistent:true};}
  }});
  const result=await broken.translate(request('Hello 11',{cacheOnly:true,segments:[{id:'bad',source:'Invalid 11'},{id:'down',source:'Unavailable'}]}));
  assert.ok(result.every(item=>item.status==='missing'));assert.equal(calls,0);
  assert.deepEqual(broken.cacheStats(),{hits:0,misses:2,writes:0,storageErrors:1,entries:1,persistent:true,healthy:false});
  const controller=new AbortController();controller.abort();
  await assert.rejects(broken.translate(request('Hello',{cacheOnly:true,signal:controller.signal})),{name:'AbortError'});assert.equal(calls,0);
  let release;
  const waiting=cachedProvider({translate(){calls++;throw new Error('Inference must not run');}},{storage:{get:()=>new Promise(resolve=>release=resolve),set(){}}});
  const duringRead=new AbortController();const pending=waiting.translate(request('Hello',{cacheOnly:true,signal:duringRead.signal}));
  await Promise.resolve();
  duringRead.abort();release({text:'Hola'});
  await assert.rejects(pending,{name:'AbortError'});assert.equal(calls,0);
});
