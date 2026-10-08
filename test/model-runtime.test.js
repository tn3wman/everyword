import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {modelRuntime} from '../src/model-runtime.js';
import {mkdtemp,writeFile,chmod,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';

test('checking an installed CUDA executable does not require GPU availability',async t=>{
  const root=await mkdtemp(join(tmpdir(),'everyword-runtime-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const binary=join(root,'llama-server');
  await writeFile(binary,'#!/bin/sh\n[ "$1" = "--version" ] && [ "${CUDA_VISIBLE_DEVICES-unset}" = "" ]\n');
  await chmod(binary,0o755);
  const child=spawnSync(process.execPath,['--input-type=module','-e',"import {llamaExecutable} from './src/model-runtime.js'; console.log(llamaExecutable()); console.log(process.env.CUDA_VISIBLE_DEVICES);"],{encoding:'utf8',env:{...process.env,EVERYWORD_LLAMA_SERVER:binary,CUDA_VISIBLE_DEVICES:'0'}});
  assert.equal(child.status,0,child.stderr);
  assert.deepEqual(child.stdout.trim().split('\n'),[binary,'0']);
});

test('a connected local runner is usable but never owned or stopped by the wrapper',async t=>{
  const server=createServer((req,res)=>{res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({status:'ok'}));});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
  const baseURL=`http://127.0.0.1:${server.address().port}/v1`;
  const runtime=modelRuntime({baseURL});
  assert.equal(await runtime.endpoint(),baseURL);assert.equal(runtime.status().ready,true);
  runtime.close();assert.equal(runtime.status().ready,false);
  assert.equal((await fetch(baseURL+'/health')).status,200);
  await assert.rejects(runtime.start(),/closed/);
});

test('runtime rejects nonlocal or credential-bearing endpoints before making requests',async()=>{
  for(const baseURL of ['https://example.com/v1','http://user:pass@127.0.0.1:1234/v1']){
    const runtime=modelRuntime({baseURL});
    await assert.rejects(runtime.start(),/loopback/);runtime.close();
  }
});
