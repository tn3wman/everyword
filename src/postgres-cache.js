import {createHash} from 'node:crypto';

const TABLE = 'everyword_translations';

function limit(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer.`);
  }
  return value;
}

const digest = key => createHash('sha256').update(key).digest('hex');

/**
 * A shared PostgreSQL translation cache. The caller owns the pool and must run
 * migrate() during application setup before serving cache traffic.
 */
export function postgresCache({pool, namespace = 'default', maxEntries = 10_000, maxBytes = 32 * 1024 * 1024} = {}) {
  if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function') {
    throw new TypeError('pool must be a PostgreSQL pool with query() and connect().');
  }
  if (typeof namespace !== 'string' || namespace.length === 0) {
    throw new TypeError('namespace must be a non-empty string.');
  }
  maxEntries = limit(maxEntries, 'maxEntries');
  maxBytes = limit(maxBytes, 'maxBytes');

  return {
    async migrate() {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS ${TABLE} (
          namespace TEXT NOT NULL,
          key TEXT NOT NULL,
          value JSONB NOT NULL,
          bytes BIGINT NOT NULL CHECK (bytes >= 0),
          accessed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
          PRIMARY KEY (namespace, key)
        )
      `);
      await pool.query(`
        CREATE INDEX IF NOT EXISTS everyword_translations_lru
        ON ${TABLE} (namespace, accessed_at, key)
      `);
    },

    async get(key) {
      if (typeof key !== 'string') throw new TypeError('Cache keys must be strings.');
      const result = await pool.query(`
        UPDATE ${TABLE}
        SET accessed_at = clock_timestamp()
        WHERE namespace = $1 AND key = $2
        RETURNING value
      `, [namespace, digest(key)]);
      return result.rows[0]?.value;
    },

    async set(key, value) {
      if (typeof key !== 'string') throw new TypeError('Cache keys must be strings.');
      const serialized = JSON.stringify(value);
      if (serialized === undefined) throw new TypeError('Cache values must be JSON-serializable.');
      const bytes = Buffer.byteLength(serialized);
      if (bytes > maxBytes || maxEntries === 0) return;

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        // One lock per namespace makes the upsert-and-evict operation atomic
        // across every application instance sharing this database.
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [namespace]);
        await client.query(`
          INSERT INTO ${TABLE} (namespace, key, value, bytes, accessed_at)
          VALUES ($1, $2, $3::jsonb, $4, clock_timestamp())
          ON CONFLICT (namespace, key) DO UPDATE SET
            value = EXCLUDED.value,
            bytes = EXCLUDED.bytes,
            accessed_at = clock_timestamp()
        `, [namespace, digest(key), serialized, bytes]);
        await client.query(`
          WITH ranked AS (
            SELECT key,
              row_number() OVER (ORDER BY accessed_at DESC, key DESC) AS position,
              sum(bytes) OVER (ORDER BY accessed_at DESC, key DESC) AS running_bytes
            FROM ${TABLE}
            WHERE namespace = $1
          )
          DELETE FROM ${TABLE} AS cached
          USING ranked
          WHERE cached.namespace = $1
            AND cached.key = ranked.key
            AND (ranked.position > $2 OR ranked.running_bytes > $3)
        `, [namespace, maxEntries, maxBytes]);
        await client.query('COMMIT');
      } catch (error) {
        try { await client.query('ROLLBACK'); } catch {}
        throw error;
      } finally {
        client.release();
      }
    },

    async clear() {
      await pool.query(`DELETE FROM ${TABLE} WHERE namespace = $1`, [namespace]);
    },

    async stats() {
      const result = await pool.query(`
        SELECT count(*)::bigint AS entries, coalesce(sum(bytes), 0)::bigint AS bytes
        FROM ${TABLE}
        WHERE namespace = $1
      `, [namespace]);
      const row = result.rows[0] ?? {entries: 0, bytes: 0};
      return {entries: Number(row.entries), bytes: Number(row.bytes), persistent: true};
    },

    async flush() {},
    async close() {}
  };
}
