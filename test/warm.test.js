import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawn} from 'node:child_process';
import {JSDOM} from 'jsdom';
import {captureDOM} from '../src/dom.js';
import {warmTranslations} from '../src/warm.js';
import {createEngine} from '../src/core.js';
import {createTranslationServer} from '../src/server.js';
import {httpProvider} from '../src/providers.js';
import {diskCache} from '../src/disk-cache.js';
import {initializeProject} from '../src/project.js';

const input=Array.from({length:130},(_,n)=>({id:`label-${n}`,source:`Settings ${n}`,context:'Appearance',kind:'text'}));
async function server(t,options){
  const instance=createTranslationServer(options);
  await new Promise(resolve=>instance.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>{instance.close(resolve);instance.closeAllConnections();}));
  return `http://127.0.0.1:${instance.address().port}`;
}
async function runCLI(args){
  const child=spawn(process.execPath,[new URL('../bin/everyword.js',import.meta.url).pathname,...args],{stdio:['ignore','pipe','pipe']});
  let stdout='',stderr='';child.stdout.on('data',value=>stdout+=value);child.stderr.on('data',value=>stderr+=value);
  const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});
  return {code,stdout,stderr};
}

test('source capture matches runtime keys and excludes private content and mathematical notation',async()=>{
  const dom=new JSDOM('<main><h1 data-everyword-ignore>Private manuscript</h1><button title="Open settings">Settings</button><input value="Private entry"><math><mi>x</mi></math></main>');
  const capture=await captureDOM(dom.window.document);
  assert.equal(capture.sourceLocale,'en');
  assert.deepEqual(capture.segments.map(s=>s.source).sort(),['Open settings','Settings']);
  assert.ok(capture.segments.every(s=>!s.context.includes('Private')));
  assert.equal(dom.window.document.documentElement.getAttribute('lang'),null);
  let calls=0;
  const warmed=new Map();
  const provider={translate:async({segments})=>{calls++;return segments.map(s=>{warmed.set(JSON.stringify([s.source,s.context,s.kind]),'Ajustes');return{id:s.id,text:'Ajustes'};});}};
  await warmTranslations({provider,locales:['es'],segments:capture.segments});
  const engine=createEngine({provider:{translate:async({segments})=>segments.map(s=>({id:s.id,text:warmed.get(JSON.stringify([s.source,s.context,s.kind]))}))}});
  const results=await engine.translate(capture.segments,{locale:'es'});
  assert.ok(results.every(r=>r.status==='translated'));assert.equal(calls,1);
});

test('prepared languages survive a fresh server and browser engine without inference',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'everyword-warm-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const cache=diskCache({path:join(directory,'owned.sqlite')});t.after(()=>cache.close());
  let calls=0;
  const provider={cacheKey:()=> 'warm-model',translate:async({targetLocale,segments})=>{calls++;return segments.map(({id,source})=>({id,text:`${targetLocale}:${source}`}));}};
  const first=await server(t,{provider,cacheStorage:cache});
  const progress=[];
  const report=await warmTranslations({provider:httpProvider({endpoint:first+'/api/translate'}),segments:input,locales:['es','fr'],onProgress:r=>progress.push(r.completed)});
  assert.equal(report.ready,true);assert.equal(report.locales.fr.translated,130);assert.deepEqual(progress,[64,128,130,64,128,130]);
  const second=await server(t,{provider:{cacheKey:()=> 'warm-model',translate(){throw new Error('No inference is allowed on prepared content');}},cacheStorage:cache});
  const engine=createEngine({provider:httpProvider({endpoint:second+'/api/translate'})});
  const results=await engine.translate(input.map(s=>({...s,id:s.id+'-new-browser'})),{locale:'fr'});
  assert.ok(results.every(r=>r.status==='translated'));assert.equal(calls,6);
  const status=await fetch(second+'/api/status').then(r=>r.json());assert.equal(status.cache.hits,130);assert.equal(status.cache.misses,0);
});

test('bad captures fail before inference and partial preparation never reports ready',async()=>{
  let calls=0;
  const provider={translate:async({segments})=>{calls++;return segments.filter(s=>s.source!=='Missing').map(({id})=>({id,text:'Ajustes'}));}};
  await assert.rejects(warmTranslations({provider,locales:['es'],segments:[{id:'same',source:'One'},{id:'same',source:'Two'}]}),/unique/);
  assert.equal(calls,0);
  const report=await warmTranslations({provider,locales:['es'],segments:[{id:'one',source:'Settings'},{id:'two',source:'Missing'}]});
  assert.equal(report.ready,false);assert.equal(report.locales.es.missing,1);assert.equal(report.locales.es.translated,1);
});

test('CLI warms only its own persistent database and reports preparation completion',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'everyword-warm-cli-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const {config}=await initializeProject(directory,{adapter:'web'});
  const cache=diskCache({path:join(directory,config.cache.path),namespace:config.cache.namespace});t.after(()=>cache.close());
  const endpoint=await server(t,{cacheStorage:cache,cacheInfo:{owner:'application',type:'sqlite',namespace:config.cache.namespace},provider:{cacheKey:()=> 'cli-model',translate:async({segments})=>segments.map(({id,source})=>({id,text:`ES:${source}`}))}});
  const path=join(directory,'capture.json');await writeFile(path,JSON.stringify({sourceLocale:'en',segments:input.slice(0,2)}));
  const args=['warm','--project',directory,'--endpoint',endpoint,'--input',path,'--locales','es','--json'];
  const done=await runCLI(args);assert.equal(done.code,0,done.stderr);assert.equal(JSON.parse(done.stdout).ready,true);assert.equal(cache.stats().entries,2);
  const wrongCache=diskCache({path:join(directory,config.cache.path),namespace:'wrong-app'});t.after(()=>wrongCache.close());
  const other=await server(t,{cacheStorage:wrongCache,cacheInfo:{owner:'application',namespace:'wrong-app'},provider:{cacheKey:()=> 'cli-model',translate(){throw new Error('Wrong cache must not be used');}}});
  const rejected=await runCLI([...args,'--endpoint',other]);assert.equal(rejected.code,1);assert.match(rejected.stderr,/this project/);assert.equal(cache.stats().entries,2);
});
