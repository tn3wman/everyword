import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {diskCache} from '../src/disk-cache.js';

async function temporaryCache(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'everyword-cache-'));
  const path = join(directory, 'translations.sqlite');
  t.after(() => rm(directory, {recursive: true, force: true}));
  const cache = diskCache({path, ...options});
  t.after(() => {
    try { cache.close(); } catch {}
  });
  return {cache, path};
}

test('values survive close and reopen', async t => {
  const {cache, path} = await temporaryCache(t);
  cache.set('es:hello', {text: 'Hola', reviewed: true});
  cache.close();
  const reopened = diskCache({path});
  t.after(() => reopened.close());
  assert.deepEqual(reopened.get('es:hello'), {text: 'Hola', reviewed: true});
  assert.deepEqual(reopened.stats(), {entries: 1, bytes: 31, persistent: true, type: 'sqlite', namespace: 'default'});
});

test('independent connections observe each other writes', async t => {
  const {cache, path} = await temporaryCache(t);
  const other = diskCache({path});
  t.after(() => other.close());
  cache.set('first', {value: 1});
  assert.deepEqual(other.get('first'), {value: 1});
  other.set('second', {value: 2});
  assert.deepEqual(cache.get('second'), {value: 2});
});

test('least recently used values are evicted by entry and byte bounds', async t => {
  const {cache} = await temporaryCache(t, {maxEntries: 2, maxBytes: 31});
  cache.set('a', {text: 'aaaa'});
  cache.set('b', {text: 'bbbb'});
  assert.deepEqual(cache.get('a'), {text: 'aaaa'});
  cache.set('c', {text: 'cccc'});
  assert.equal(cache.get('b'), undefined);
  assert.deepEqual(cache.get('a'), {text: 'aaaa'});
  assert.deepEqual(cache.get('c'), {text: 'cccc'});
  assert.deepEqual(cache.stats(), {entries: 2, bytes: 30, persistent: true, type: 'sqlite', namespace: 'default'});

  cache.set('large', {text: 'a payload too large for this cache'});
  assert.equal(cache.get('large'), undefined);
  assert.deepEqual(cache.stats(), {entries: 2, bytes: 30, persistent: true, type: 'sqlite', namespace: 'default'});
});

test('overwriting a key replaces its byte accounting', async t => {
  const {cache} = await temporaryCache(t);
  cache.set('key', {text: 'longer value'});
  const before = cache.stats().bytes;
  cache.set('key', {text: 'x'});
  assert.equal(cache.stats().entries, 1);
  assert.ok(cache.stats().bytes < before);
  assert.equal(cache.stats().bytes, Buffer.byteLength(JSON.stringify({text: 'x'})));
});

test('malformed stored JSON is discarded and treated as a miss', async t => {
  const {cache, path} = await temporaryCache(t);
  cache.set('broken', {valid: true});
  const database = new DatabaseSync(path);
  const key = createHash('sha256').update('broken').digest('hex');
  database.prepare('UPDATE everyword_translations SET value = ? WHERE key = ?').run('{bad', key);
  database.close();
  assert.equal(cache.get('broken'), undefined);
  assert.equal(cache.stats().entries, 0);
});
