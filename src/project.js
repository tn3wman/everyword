import {randomUUID} from 'node:crypto';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {dirname, isAbsolute, join, relative, resolve} from 'node:path';
import {inspectProject} from './inspect.js';

const CONFIG_NAME = 'everyword.config.json';
const adapters = new Set(['web', 'electron', 'native', 'messages']);
const storageTypes = new Set(['sqlite', 'postgres', 'memory']);
const localePattern = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;
const envPattern = /^[A-Za-z_][A-Za-z0-9_]*$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function plain(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key) || ['__proto__', 'prototype', 'constructor'].includes(key)) {
      throw new TypeError(`${label} contains an unsupported property: ${key}`);
    }
  }
}

function validLocale(value, label) {
  if (typeof value !== 'string' || !localePattern.test(value)) throw new TypeError(`${label} must be a locale tag.`);
  try { return new Intl.Locale(value).toString(); }
  catch { throw new TypeError(`${label} must be a locale tag.`); }
}

function validEndpoint(value) {
  if (typeof value !== 'string') throw new TypeError('endpoint must be an HTTP URL.');
  let url;
  try { url = new URL(value); } catch { throw new TypeError('endpoint must be an HTTP URL.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new TypeError('endpoint must be an HTTP URL without credentials.');
  }
  if (url.search || url.hash) throw new TypeError('endpoint must not include a query or fragment.');
  return value.replace(/\/+$/, '');
}

export function validateProjectConfig(config) {
  if (!plain(config)) throw new TypeError('Project config must be a plain object.');
  exactKeys(config, new Set(['version', 'sourceLocale', 'locale', 'endpoint', 'adapter', 'cache']), 'Project config');
  if (config.version !== 1) throw new TypeError('Project config version must be 1.');
  validLocale(config.sourceLocale, 'sourceLocale');
  validLocale(config.locale, 'locale');
  validEndpoint(config.endpoint);
  if (!adapters.has(config.adapter)) throw new TypeError('adapter must be web, electron, native, or messages.');
  if (!plain(config.cache)) throw new TypeError('cache must be a plain object.');
  if (!storageTypes.has(config.cache.type)) throw new TypeError('cache.type must be sqlite, postgres, or memory.');
  if (typeof config.cache.namespace !== 'string' || !uuidPattern.test(config.cache.namespace)) throw new TypeError('cache.namespace must be a UUID.');
  if (config.cache.type === 'sqlite') {
    exactKeys(config.cache, new Set(['type', 'path', 'namespace']), 'cache');
    if (typeof config.cache.path !== 'string' || !config.cache.path || isAbsolute(config.cache.path) || relative('.', config.cache.path).startsWith('..')) {
      throw new TypeError('cache.path must be a relative path inside the project.');
    }
  } else if (config.cache.type === 'postgres') {
    exactKeys(config.cache, new Set(['type', 'connectionEnv', 'namespace']), 'cache');
    if (typeof config.cache.connectionEnv !== 'string' || !envPattern.test(config.cache.connectionEnv)) throw new TypeError('cache.connectionEnv must be an environment variable name.');
  } else {
    exactKeys(config.cache, new Set(['type', 'namespace']), 'cache');
  }
  return config;
}

export async function readProjectConfig(directory) {
  const path = join(resolve(directory), CONFIG_NAME);
  let source;
  try { source = await readFile(path, 'utf8'); }
  catch (error) { if (error?.code === 'ENOENT') return undefined; throw error; }
  let config;
  try { config = JSON.parse(source); }
  catch { throw new TypeError(`${CONFIG_NAME} is not valid JSON.`); }
  return validateProjectConfig(config);
}

function chooseAdapter(inspection, directory, requested) {
  if (requested !== 'auto') return requested;
  const frameworks = new Set(inspection.frameworks);
  if (frameworks.has('electron')) return 'electron';
  const web = [...frameworks].some((name) => ['react', 'next', 'vue', 'svelte', '@angular/core'].includes(name));
  const native = [...frameworks].some((name) => /native|Swift|Kotlin|Flutter/.test(name));
  if (native && !web) return 'native';
  if (!web && !native && !inspection.files.some(file => /\.html$/.test(file)) && inspection.files.includes('package.json')) return 'messages';
  return 'web';
}

function moduleSource(config) {
  const endpoint = JSON.stringify(config.endpoint);
  const sourceLocale = JSON.stringify(config.sourceLocale);
  const locale = JSON.stringify(config.locale);
  const common = `const endpoint = ${endpoint};\nconst sourceLocale = ${sourceLocale};\nconst defaultLocale = ${locale};\n\nasync function provider(storage) {\n  const statusResponse = await fetch(\`${'${endpoint}'}/api/status\`);\n  if (!statusResponse.ok) throw new Error(\`Everyword status request failed: ${'${statusResponse.status}'}\`);\n  const {revision} = await statusResponse.json();\n  return cachedProvider(httpProvider({endpoint: \`${'${endpoint}'}/api/translate\`}), {\n    version: revision,\n    storage: browserCache({storage: storage ?? null}),\n  });\n}\n`;
  if (config.adapter === 'web') return `import {browserCache, cachedProvider, createEngine, httpProvider, wrapDOM} from 'everyword';\n\n${common}\nexport default async function mountEveryword(root = document, {locale = defaultLocale, onReport, storage} = {}) {\n  const engine = createEngine({sourceLocale, provider: await provider(storage)});\n  const wrapper = wrapDOM(root, {engine, locale, onReport}); await wrapper.ready; return wrapper;\n}\n`;
  if (config.adapter === 'electron') return `import {browserCache, cachedProvider, createEngine, httpProvider, translateElectronMenu, wrapDOM} from 'everyword';\n\n${common}\nexport async function mountEverywordRenderer(root = document, {locale = defaultLocale, onReport, storage} = {}) {\n  const engine = createEngine({sourceLocale, provider: await provider(storage)});\n  const wrapper = wrapDOM(root, {engine, locale, onReport}); await wrapper.ready; return wrapper;\n}\n\nexport async function translateEverywordMenu(template, {locale = defaultLocale} = {}) {\n  const engine = createEngine({sourceLocale, provider: await provider()});\n  return translateElectronMenu(template, {engine, locale});\n}\n`;
  if (config.adapter === 'native') return `import {createEngine, httpProvider, wrapAdapter} from 'everyword';\n\nconst endpoint = ${endpoint};\nconst sourceLocale = ${sourceLocale};\nconst defaultLocale = ${locale};\n\nexport function createEverywordBridge(host, {locale = defaultLocale, onReport} = {}) {\n  for (const name of ['captureOriginalText', 'applyText', 'restoreText']) {\n    if (typeof host?.[name] !== 'function') throw new TypeError(\`host.${'${name}'} must be a function\`);\n  }\n  const engine = createEngine({sourceLocale, provider: httpProvider({endpoint: \`${'${endpoint}'}/api/translate\`})});\n  return wrapAdapter({\n    capture: () => host.captureOriginalText(),\n    apply: (results, context) => host.applyText(results, context),\n    restore: () => host.restoreText(),\n  }, {engine, locale, onReport});\n}\n`;
  return `import {createEngine, httpProvider, translateObject} from 'everyword';\n\nconst endpoint = ${endpoint};\nconst sourceLocale = ${sourceLocale};\nconst defaultLocale = ${locale};\nconst engine = createEngine({sourceLocale, provider: httpProvider({endpoint: \`${'${endpoint}'}/api/translate\`})});\n\nexport function translateEverywordMessages(value, {locale = defaultLocale, context, keys} = {}) {\n  return translateObject(value, {engine, locale, context, keys});\n}\n`;
}

function wiring(adapter, integrationPath) {
  if (adapter === 'web') return `Import mountEveryword from ${integrationPath} and call await mountEveryword(document) after the document is available.`;
  if (adapter === 'electron') return `In the renderer, import { mountEverywordRenderer } from ${integrationPath} and call it after the document is available. In the main process, pass menu templates through translateEverywordMenu before Menu.buildFromTemplate.`;
  if (adapter === 'native') return `Import { createEverywordBridge } from ${integrationPath}, provide captureOriginalText, applyText, and restoreText host functions, then call bridge.refresh(). Everyword cannot intercept native views automatically.`;
  return `Import { translateEverywordMessages } from ${integrationPath} and pass owned message objects through it before delivery.`;
}

export async function initializeProject(directory, {
  storage = 'sqlite', databaseEnv = 'EVERYWORD_DATABASE_URL', cachePath = '.everyword/translations.sqlite',
  endpoint = 'http://127.0.0.1:4317', locale = 'es', sourceLocale = 'en', adapter = 'auto',
} = {}) {
  const root = resolve(directory);
  if (!storageTypes.has(storage)) throw new TypeError('storage must be sqlite, postgres, or memory.');
  if (![...adapters, 'auto'].includes(adapter)) throw new TypeError('adapter must be auto, web, electron, native, or messages.');
  if (storage === 'postgres' && (typeof databaseEnv !== 'string' || !envPattern.test(databaseEnv))) throw new TypeError('databaseEnv must be an environment variable name.');
  if (storage === 'sqlite' && (typeof cachePath !== 'string' || !cachePath || isAbsolute(cachePath) || relative('.', cachePath).startsWith('..'))) throw new TypeError('cachePath must be a relative path inside the project.');
  const normalizedEndpoint = validEndpoint(endpoint);
  const normalizedSource = validLocale(sourceLocale, 'sourceLocale');
  const normalizedLocale = validLocale(locale, 'locale');
  const inspection = await inspectProject(root);
  const existing = await readProjectConfig(root);
  const selected = existing?.adapter ?? chooseAdapter(inspection, root, adapter);
  const config = existing ?? {
    version: 1, sourceLocale: normalizedSource, locale: normalizedLocale, endpoint: normalizedEndpoint, adapter: selected,
    cache: storage === 'sqlite' ? {type: storage, path: cachePath, namespace: randomUUID()}
      : storage === 'postgres' ? {type: storage, connectionEnv: databaseEnv, namespace: randomUUID()}
        : {type: storage, namespace: randomUUID()},
  };
  validateProjectConfig(config);
  const integrationRelative = `everyword/${config.adapter === 'web' ? 'client' : config.adapter}.js`;
  const integrationPath = join(root, integrationRelative);
  const expectedModule = moduleSource(config);
  let currentModule;
  try { currentModule = await readFile(integrationPath, 'utf8'); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
  if (currentModule !== undefined && currentModule !== expectedModule) throw new Error(`Refusing to overwrite existing file: ${integrationRelative}`);
  const configPath = join(root, CONFIG_NAME);
  if (!existing) {
    await mkdir(dirname(integrationPath), {recursive: true});
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, {flag: 'wx'});
  } else {
    await mkdir(dirname(integrationPath), {recursive: true});
  }
  if (currentModule === undefined) await writeFile(integrationPath, expectedModule, {flag: 'wx'});
  return {
    config, configPath, integrationPath,
    instructions: wiring(config.adapter, integrationRelative),
    inspection,
    gaps: inspection.gaps,
    needsNativeHostMapping: config.adapter === 'native',
  };
}
