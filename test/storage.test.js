import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {initializeProject} from '../src/project.js';
import {openProjectStorage,doctorProject} from '../src/storage.js';
import {DatabaseSync} from 'node:sqlite';
import {diskCache} from '../src/disk-cache.js';

async function project(t){const directory=await mkdtemp(join(tmpdir(),'everyword-storage-'));t.after(()=>rm(directory,{recursive:true,force:true}));const {config}=await initializeProject(directory,{adapter:'web'});return {directory,config};}

test('project storage persists translations in the selected app file and never alters app tables',async t=>{
  const {directory,config}=await project(t);
  const first=await openProjectStorage(config,{directory,migrate:true});
  first.storage.set('hello',{text:'Hola'});await first.close();
  const db=new DatabaseSync(join(directory,config.cache.path));db.exec("CREATE TABLE documents(title TEXT); INSERT INTO documents VALUES('Private manuscript');");db.close();
  const reopened=await openProjectStorage(config,{directory});assert.deepEqual(reopened.storage.get('hello'),{text:'Hola'});assert.equal(reopened.info.owner,'application');await reopened.close();
  const check=new DatabaseSync(join(directory,config.cache.path));assert.equal(check.prepare('SELECT title FROM documents').get().title,'Private manuscript');check.close();
});

test('cache namespaces isolate reads, clears and eviction in a shared SQLite file',async t=>{
  const {directory,config}=await project(t),path=join(directory,config.cache.path);
  const first=diskCache({path,namespace:'website',maxEntries:1}),second=diskCache({path,namespace:'desktop'});t.after(()=>{first.close();second.close();});
  first.set('a',{text:'Uno'});second.set('a',{text:'Dos'});first.set('b',{text:'Tres'});
  assert.equal(first.get('a'),undefined);assert.deepEqual(second.get('a'),{text:'Dos'});first.clear();assert.equal(second.stats().entries,1);
});

test('doctor does not create a database or migrate tables',async t=>{
  const {directory,config}=await project(t);
  const before=await doctorProject(directory);assert.equal(before.checks.find(c=>c.name==='database').ok,false);
  await assert.rejects(stat(join(directory,config.cache.path)),{code:'ENOENT'});
  const opened=await openProjectStorage(config,{directory,migrate:true});await opened.close();
  assert.equal((await doctorProject(directory)).checks.find(c=>c.name==='database').ok,true);
});

test('PostgreSQL configuration reports missing credentials without saving or exposing them',async t=>{
  const {directory,config}=await project(t);config.cache={type:'postgres',namespace:config.cache.namespace,connectionEnv:'EVERYWORD_MISSING_TEST_CREDENTIAL'};
  await assert.rejects(openProjectStorage(config,{directory}),/Inject EVERYWORD_MISSING_TEST_CREDENTIAL with Infisical/);
});
