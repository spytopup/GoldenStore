import pg from 'pg';
const { Pool } = pg;
let pool;
let schemaReady;

export function getPool() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not configured');
  if (!pool) pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 5, idleTimeoutMillis: 10000, connectionTimeoutMillis: 10000 });
  return pool;
}

export async function ensureSchema() {
  if (!schemaReady) {
    schemaReady = (async () => {
      const db = getPool();
      await db.query(`CREATE TABLE IF NOT EXISTS goldenstore_state (
        singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
        data JSONB NOT NULL DEFAULT '{"categories":[],"products":[],"apiData":{},"tombstones":[]}'::jsonb,
        revision BIGINT NOT NULL DEFAULT 0,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      await db.query(`INSERT INTO goldenstore_state(singleton) VALUES(TRUE) ON CONFLICT(singleton) DO NOTHING`);
      await db.query(`CREATE TABLE IF NOT EXISTS goldenstore_servers (
        server_id TEXT PRIMARY KEY, last_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(), metadata JSONB NOT NULL DEFAULT '{}'::jsonb
      )`);
      await db.query(`CREATE TABLE IF NOT EXISTS goldenstore_commands (
        id BIGSERIAL PRIMARY KEY, target_server TEXT, payload JSONB NOT NULL, status TEXT NOT NULL DEFAULT 'pending', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), confirmed_at TIMESTAMPTZ
      )`);
    })().catch(err => { schemaReady = null; throw err; });
  }
  return schemaReady;
}

export async function readState(client = getPool()) {
  const r = await client.query('SELECT data, revision, updated_at FROM goldenstore_state WHERE singleton=TRUE');
  return r.rows[0] ?? { data: { categories: [], products: [], apiData: {}, tombstones: [] }, revision: 0, updated_at: new Date() };
}

export function normalizeData(input) {
  const d = input && typeof input === 'object' && !Array.isArray(input) ? structuredClone(input) : {};
  if (!Array.isArray(d.categories)) d.categories = [];
  if (!Array.isArray(d.products)) d.products = [];
  if (!d.apiData || typeof d.apiData !== 'object' || Array.isArray(d.apiData)) d.apiData = {};
  if (!Array.isArray(d.tombstones)) d.tombstones = [];
  d.updatedAt = Date.now();
  return d;
}

export async function writeState(data) {
  const db = getPool();
  const normalized = normalizeData(data);
  const r = await db.query(`UPDATE goldenstore_state SET data=$1::jsonb, revision=revision+1, updated_at=NOW() WHERE singleton=TRUE RETURNING revision, updated_at`, [JSON.stringify(normalized)]);
  return { data: normalized, revision: Number(r.rows[0].revision), updatedAt: r.rows[0].updated_at };
}

export function mergeByKey(existing, incoming, key) {
  const map = new Map();
  for (const item of [...(Array.isArray(existing) ? existing : []), ...(Array.isArray(incoming) ? incoming : [])]) {
    const id = item && typeof item === 'object' ? item[key] : item;
    if (id == null) continue;
    map.set(String(id).toLowerCase(), item);
  }
  return [...map.values()];
}
