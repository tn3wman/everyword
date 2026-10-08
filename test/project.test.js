import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import test from 'node:test';
import {initializeProject, readProjectConfig, validateProjectConfig} from '../src/project.js';

async function temporary(t) {
  const directory = await mkdtemp(join(tmpdir(), 'everyword-project-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  return directory;
}

test('initializes a web project idempotently and preserves authored files', async (t) => {
  const directory = await temporary(t);
  await writeFile(join(directory, 'index.html'), '<main>Hello</main>');
  const authored = join(directory, 'app.js');
  await writeFile(authored, 'export const app = true;\n');
  const first = await initializeProject(directory);
  const firstConfigText = await readFile(first.configPath, 'utf8');
  const firstModule = await readFile(first.integrationPath, 'utf8');
  const second = await initializeProject(directory);
  assert.equal(second.config.cache.namespace, first.config.cache.namespace);
  assert.equal(await readFile(first.configPath, 'utf8'), firstConfigText);
  assert.equal(await readFile(first.integrationPath, 'utf8'), firstModule);
  assert.equal(await readFile(authored, 'utf8'), 'export const app = true;\n');
  assert.equal(first.config.adapter, 'web');
  assert.match(firstModule, /from 'everyword'/);
  assert.match(firstModule, /wrapDOM\(root/);
  assert.match(first.instructions, /mountEveryword\(document\)/);
});

test('detects Electron, native-only, and Node message projects', async (t) => {
  const electron = await temporary(t);
  await writeFile(join(electron, 'package.json'), JSON.stringify({dependencies: {electron: '1.0.0'}}));
  assert.equal((await initializeProject(electron)).config.adapter, 'electron');

  const native = await temporary(t);
  await writeFile(join(native, 'Screen.swift'), 'struct Screen {}');
  const nativeResult = await initializeProject(native);
  assert.equal(nativeResult.config.adapter, 'native');
  assert.equal(nativeResult.needsNativeHostMapping, true);
  assert.match(await readFile(nativeResult.integrationPath, 'utf8'), /captureOriginalText/);

  const node = await temporary(t);
  await writeFile(join(node, 'package.json'), JSON.stringify({type: 'module'}));
  const messages = await initializeProject(node);
  assert.equal(messages.config.adapter, 'messages');
  assert.match(await readFile(messages.integrationPath, 'utf8'), /translateObject/);
});

test('stores only the Postgres environment variable name', async (t) => {
  const directory = await temporary(t);
  const result = await initializeProject(directory, {storage: 'postgres', databaseEnv: 'APP_DATABASE_URL'});
  const source = await readFile(result.configPath, 'utf8');
  assert.equal(result.config.cache.connectionEnv, 'APP_DATABASE_URL');
  assert.doesNotMatch(source, /postgres(?:ql)?:\/\//);
});

test('invalid options and existing config fail before writing generated files', async (t) => {
  const invalidOption = await temporary(t);
  await assert.rejects(initializeProject(invalidOption, {endpoint: 'http://user:secret@localhost:4317'}), /without credentials/);
  await assert.rejects(readFile(join(invalidOption, 'everyword.config.json')), {code: 'ENOENT'});

  const invalidConfig = await temporary(t);
  await writeFile(join(invalidConfig, 'everyword.config.json'), JSON.stringify({version: 1, __proto__: {polluted: true}}));
  await assert.rejects(initializeProject(invalidConfig), /sourceLocale|unsupported/);
  await assert.rejects(readFile(join(invalidConfig, 'everyword', 'client.js')), {code: 'ENOENT'});
});

test('refuses to overwrite an existing integration before creating config', async (t) => {
  const directory = await temporary(t);
  await mkdir(join(directory, 'everyword'));
  await writeFile(join(directory, 'everyword', 'client.js'), '// authored\n');
  await assert.rejects(initializeProject(directory), /Refusing to overwrite/);
  assert.equal(await readProjectConfig(directory), undefined);
  assert.equal(await readFile(join(directory, 'everyword', 'client.js'), 'utf8'), '// authored\n');
});

test('validates the closed config schema and safe cache paths', () => {
  const base = {
    version: 1, sourceLocale: 'en', locale: 'es', endpoint: 'http://127.0.0.1:4317', adapter: 'web',
    cache: {type: 'memory', namespace: '123e4567-e89b-42d3-a456-426614174000'},
  };
  assert.equal(validateProjectConfig(base), base);
  assert.throws(() => validateProjectConfig({...base, surprise: true}), /unsupported property/);
  assert.throws(() => validateProjectConfig({...base, cache: {type: 'sqlite', path: '../outside', namespace: base.cache.namespace}}), /inside the project/);
  assert.throws(() => validateProjectConfig({...base, cache: {type: 'postgres', connectionEnv: 'postgres://secret', namespace: base.cache.namespace}}), /environment variable name/);
});

test('every generated adapter is valid JavaScript', async (t) => {
  for (const adapter of ['web', 'electron', 'native', 'messages']) {
    const directory = await temporary(t);
    const {integrationPath} = await initializeProject(directory, {adapter});
    const checked = spawnSync(process.execPath, ['--check', integrationPath], {encoding: 'utf8'});
    assert.equal(checked.status, 0, `${adapter}: ${checked.stderr}`);
  }
});

test('generated web integration mounts real content and restores its original language',async t=>{
  const {JSDOM}=await import('jsdom');
  const {pathToFileURL}=await import('node:url');
  const {createTranslationServer}=await import('../src/server.js');
  const server=createTranslationServer({provider:{translate:async({segments})=>segments.map(({id,source})=>({id,text:source==='Hello {name}'?'Hola {name}':'Hola'}))},cacheStorage:false});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
  const directory=await temporary(t);
  const generated=await initializeProject(directory,{endpoint:`http://127.0.0.1:${server.address().port}`,adapter:'web'});
  const source=(await readFile(generated.integrationPath,'utf8')).replace("from 'everyword'",`from '${new URL('../src/index.js',import.meta.url).href}'`);
  await writeFile(generated.integrationPath,source);
  const {default:mount}=await import(pathToFileURL(generated.integrationPath).href);
  const dom=new JSDOM('<main><h2>Hello {name}</h2><p data-everyword-ignore>Private manuscript</p><input value="My private note"></main>');
  const root=dom.window.document.querySelector('main'),wrapper=await mount(root,{locale:'es'});
  assert.equal(root.querySelector('h2').textContent,'Hola {name}');assert.equal(root.querySelector('p').textContent,'Private manuscript');assert.equal(root.querySelector('input').value,'My private note');
  await wrapper.setLocale('en');assert.equal(root.querySelector('h2').textContent,'Hello {name}');wrapper.disconnect();
});
