import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {postgresCache} from '../src/postgres-cache.js';

const hash = value => createHash('sha256').update(value).digest('hex');

function recordingPool(responses = []) {
  const calls = [];
  let released = 0;
  const query = async (text, values) => {
    calls.push({text: text.trim(), values});
    return responses.shift() ?? {rows: []};
  };
  const client = {query, release() { released++; }};
  return {calls, query, async connect() { return client; }, get released() { return released; }};
}

test('requires a caller-owned PostgreSQL pool and valid bounds', () => {
  assert.throws(() => postgresCache(), /pool/);
  const pool = recordingPool();
  assert.throws(() => postgresCache({pool, namespace: ''}), /namespace/);
  assert.throws(() => postgresCache({pool, maxEntries: -1}), /maxEntries/);
  assert.throws(() => postgresCache({pool, maxBytes: 1.5}), /maxBytes/);
});

test('migration is explicit, additive, and idempotent SQL', async () => {
  const pool = recordingPool();
  const cache = postgresCache({pool});
  assert.equal(pool.calls.length, 0);
  await cache.migrate();
  await cache.migrate();
  assert.equal(pool.calls.length, 4);
  for (const {text} of pool.calls) {
    assert.match(text, /IF NOT EXISTS/);
    assert.match(text, /everyword_translations/);
    assert.doesNotMatch(text, /\b(DROP|TRUNCATE|ALTER)\b/i);
  }
});

test('get hashes keys, isolates namespaces, and returns JSON values', async () => {
  const pool = recordingPool([{rows: [{value: {text: 'Hola'}}]}, {rows: []}]);
  const first = postgresCache({pool, namespace: 'tenant-a'});
  const second = postgresCache({pool, namespace: 'tenant-b'});
  assert.deepEqual(await first.get('secret raw key'), {text: 'Hola'});
  assert.equal(await second.get('secret raw key'), undefined);
  assert.deepEqual(pool.calls.map(call => call.values), [
    ['tenant-a', hash('secret raw key')],
    ['tenant-b', hash('secret raw key')]
  ]);
  assert.ok(pool.calls.every(call => !call.text.includes('secret raw key')));
});

test('set uses a namespace lock, parameterized JSON, and bounded LRU eviction', async () => {
  const pool = recordingPool();
  const cache = postgresCache({pool, namespace: 'site', maxEntries: 2, maxBytes: 100});
  await cache.set('hello', {text: 'Hola'});
  assert.deepEqual(pool.calls.map(call => call.text.split(/\s+/)[0]), ['BEGIN', 'SELECT', 'INSERT', 'WITH', 'COMMIT']);
  assert.match(pool.calls[1].text, /pg_advisory_xact_lock/);
  assert.deepEqual(pool.calls[1].values, ['site']);
  assert.deepEqual(pool.calls[2].values, ['site', hash('hello'), '{"text":"Hola"}', 15]);
  assert.doesNotMatch(pool.calls[2].text, /Hola/);
  assert.deepEqual(pool.calls[3].values, ['site', 2, 100]);
  assert.match(pool.calls[3].text, /running_bytes > \$3/);
  assert.match(pool.calls[3].text, /position > \$2/);
  assert.equal(pool.released, 1);
});

test('set rolls back and releases its connection after a query failure', async () => {
  const calls = [];
  let released = false;
  const client = {
    async query(text) {
      calls.push(text.trim());
      if (calls.length === 3) throw new Error('write failed');
      return {rows: []};
    },
    release() { released = true; }
  };
  const pool = {query: client.query, async connect() { return client; }};
  await assert.rejects(postgresCache({pool}).set('a', {a: 1}), /write failed/);
  assert.equal(calls.at(-1), 'ROLLBACK');
  assert.equal(released, true);
});

test('oversized and disabled writes do not acquire a connection', async () => {
  let connections = 0;
  const pool = recordingPool();
  pool.connect = async () => { connections++; throw new Error('must not connect'); };
  await postgresCache({pool, maxBytes: 2}).set('a', {a: 1});
  await postgresCache({pool, maxEntries: 0}).set('a', null);
  assert.equal(connections, 0);
});

test('clear and stats affect only their namespace; close never ends the pool', async () => {
  const pool = recordingPool([{rows: []}, {rows: [{entries: '3', bytes: '42'}]}]);
  let ended = false;
  pool.end = () => { ended = true; };
  const cache = postgresCache({pool, namespace: 'only-me'});
  await cache.clear();
  assert.deepEqual(await cache.stats(), {entries: 3, bytes: 42, persistent: true});
  await cache.flush();
  await cache.close();
  assert.deepEqual(pool.calls[0].values, ['only-me']);
  assert.deepEqual(pool.calls[1].values, ['only-me']);
  assert.ok(pool.calls.slice(0, 2).every(call => /WHERE namespace = \$1/.test(call.text)));
  assert.equal(ended, false);
});

const databaseURL = process.env.EVERYWORD_TEST_DATABASE_URL;
test('real PostgreSQL preserves namespace isolation and bounds concurrent writers', {skip: !databaseURL}, async t => {
  const firstPool = new Pool({connectionString: databaseURL, max: 4});
  const secondPool = new Pool({connectionString: databaseURL, max: 4});
  const namespace = `test-${randomUUID()}`;
  const neighborNamespace = `test-${randomUUID()}`;
  const first = postgresCache({pool: firstPool, namespace, maxEntries: 2, maxBytes: 32});
  const second = postgresCache({pool: secondPool, namespace, maxEntries: 2, maxBytes: 32});
  const neighbor = postgresCache({pool: firstPool, namespace: neighborNamespace});
  t.after(async () => {
    await Promise.all([first.clear(), neighbor.clear()]);
    await Promise.all([firstPool.end(), secondPool.end()]);
  });

  await first.migrate();
  await second.migrate();
  await neighbor.set('shared', {text: 'neighbor'});
  await Promise.all([
    first.set('a', {text: 'aaaa'}),
    second.set('b', {text: 'bbbb'}),
    first.set('c', {text: 'cccc'})
  ]);

  assert.deepEqual(await first.stats(), {entries: 2, bytes: 30, persistent: true});
  assert.deepEqual(await neighbor.get('shared'), {text: 'neighbor'});
  assert.equal(await first.get('shared'), undefined);
  await first.set('too-large', {text: 'x'.repeat(100)});
  assert.deepEqual(await first.stats(), {entries: 2, bytes: 30, persistent: true});

  await second.clear();
  assert.deepEqual(await first.stats(), {entries: 0, bytes: 0, persistent: true});
  assert.deepEqual(await neighbor.get('shared'), {text: 'neighbor'});
  await first.close();
  assert.deepEqual((await firstPool.query('SELECT 1 AS alive')).rows, [{alive: 1}]);
});
