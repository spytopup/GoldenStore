import { ensureSchema, getPool, readState, writeState, normalizeData, mergeByKey } from '../lib/db.js';
import crypto from 'node:crypto';

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}
async function body(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  let raw = '';
  for await (const chunk of req) { raw += chunk; if (raw.length > 5_000_000) throw new Error('Request body too large'); }
  if (!raw) return {};
  return JSON.parse(raw);
}
function safeEqual(a, b) {
  const aa = Buffer.from(String(a ?? '')); const bb = Buffer.from(String(b ?? ''));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}
function keyOf(req) { return req.headers['x-api-key'] || req.headers.authorization?.replace(/^Bearer\s+/i, ''); }
function idOf(item, key) { return item && typeof item === 'object' ? item[key] : item; }

export default async function handler(req, res) {
  const origin = process.env.CORS_ORIGIN || '';
  if (origin) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key, x-server-id, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return send(res, 204, {});

  const expected = process.env.GOLDENSTORE_API_KEY;
  if (!expected || expected.length < 32 || expected.startsWith('replace-')) return send(res, 503, { error: 'configure_GOLDENSTORE_API_KEY_at_least_32_chars' });
  if (!safeEqual(keyOf(req), expected)) return send(res, 401, { error: 'unauthorized' });

  try {
    await ensureSchema();
    const path = '/' + (Array.isArray(req.query.path) ? req.query.path.join('/') : (req.query.path || ''));
    const method = req.method.toUpperCase();
    const serverId = String(req.headers['x-server-id'] || 'external').slice(0, 100);

    if (method === 'GET' && ['/api/v1/data', '/api/store/catalog'].includes(path)) {
      const s = await readState(); return send(res, 200, s.data);
    }
    if (method === 'POST' && ['/api/v1/data', '/api/store/catalog/sync'].includes(path)) {
      const result = await writeState(await body(req)); return send(res, 200, { success: true, revision: result.revision, updatedAt: result.updatedAt });
    }
    if (method === 'POST' && path === '/api/v1/sync') {
      const packet = await body(req);
      const id = String(packet.serverId || serverId).slice(0, 100);
      const db = getPool();
      await db.query('INSERT INTO goldenstore_servers(server_id, metadata) VALUES($1,$2::jsonb) ON CONFLICT(server_id) DO UPDATE SET last_seen=NOW(), metadata=EXCLUDED.metadata', [id, JSON.stringify({ source: 'paper', op: packet.op || 'HELLO' })]);
      const op = String(packet.op || 'HELLO').toUpperCase();
      let current = await readState();
      if (packet.database && typeof packet.database === 'object') {
        if (op === 'HELLO') {
          // Initial merge only adds/updates by stable ID. Existing tombstones win to prevent deleted records returning.
          const incoming = normalizeData(packet.database);
          const tomb = new Set((current.data.tombstones || []).map(t => `${t.type}:${String(t.id).toLowerCase()}`));
          let merged = normalizeData(current.data);
          merged.categories = mergeByKey(merged.categories, incoming.categories.filter(x => !tomb.has(`category:${String(idOf(x,'name')).toLowerCase()}`)), 'name');
          merged.products = mergeByKey(merged.products, incoming.products.filter(x => !tomb.has(`product:${String(idOf(x,'id')).toLowerCase()}`)), 'id');
          merged.apiData = { ...merged.apiData, ...incoming.apiData };
          await writeState(merged);
        } else if (op === 'UPDATE') {
          // Snapshot update from a trusted plugin server. Preserve tombstones and filter deleted entries.
          const incoming = normalizeData(packet.database);
          const tomb = new Set((current.data.tombstones || []).map(t => `${t.type}:${String(t.id).toLowerCase()}`));
          incoming.categories = incoming.categories.filter(x => !tomb.has(`category:${String(idOf(x,'name')).toLowerCase()}`));
          incoming.products = incoming.products.filter(x => !tomb.has(`product:${String(idOf(x,'id')).toLowerCase()}`));
          incoming.tombstones = current.data.tombstones || [];
          await writeState(incoming);
        }
      }
      current = await readState();
      return send(res, 200, { success: true, database: current.data, revision: Number(current.revision), updatedAt: current.updated_at });
    }
    if (method === 'GET' && ['/api/v1/servers', '/api/server/list'].includes(path)) {
      const r = await getPool().query('SELECT server_id AS name, last_seen FROM goldenstore_servers ORDER BY server_id');
      return send(res, 200, { servers: r.rows.map(x => ({ name: x.name, lastSeen: x.last_seen, onlinePlayers: 0 })) });
    }
    if (method === 'POST' && path === '/api/v1/data/delete') {
      const b = await body(req); return await deleteRecord(String(b.type || ''), String(b.id || ''));
    }
    if (method === 'DELETE' && path.startsWith('/api/store/category/')) return await deleteRecord('category', decodeURIComponent(path.split('/').pop()));
    if (method === 'DELETE' && path.startsWith('/api/store/product/')) return await deleteRecord('product', decodeURIComponent(path.split('/').pop()));
    if (method === 'POST' && path === '/api/store/product') {
      const product = await body(req); const state = await readState(); const data = normalizeData(state.data);
      if (!product.id) return send(res, 400, { error: 'product_id_required' });
      data.products = mergeByKey(data.products, [product], 'id');
      const result = await writeState(data); return send(res, 200, { success: true, revision: result.revision });
    }
    if (method === 'POST' && path === '/api/player/sync') {
      const player = await body(req); if (!player.uuid) return send(res, 400, { error: 'player_uuid_required' });
      const state = await readState(); const data = normalizeData(state.data);
      data.apiData.players ||= {};
      data.apiData.players[player.uuid] = { ...(data.apiData.players[player.uuid] || {}), ...player, lastSeen: Date.now() };
      await writeState(data); return send(res, 200, { success: true });
    }
    if (method === 'GET' && path === '/api/commands/pending') {
      const target = String(req.query.serverId || serverId);
      const r = await getPool().query("SELECT id, payload FROM goldenstore_commands WHERE status='pending' AND (target_server IS NULL OR target_server=$1) ORDER BY id LIMIT 100", [target]);
      return send(res, 200, { queue: r.rows.map(x => ({ ...x.payload, taskId: String(x.id) })) });
    }
    if (method === 'POST' && path.startsWith('/api/commands/confirm/')) {
      const id = path.split('/').pop(); const b = await body(req);
      await getPool().query("UPDATE goldenstore_commands SET status=$2, confirmed_at=NOW() WHERE id=$1", [id, b.success ? 'executed' : 'failed']);
      return send(res, 200, { success: true });
    }
    if (method === 'POST' && path === '/api/commands') {
      const b = await body(req); const r = await getPool().query('INSERT INTO goldenstore_commands(target_server,payload) VALUES($1,$2::jsonb) RETURNING id', [b.serverId || null, JSON.stringify(b)]);
      return send(res, 201, { success: true, id: String(r.rows[0].id) });
    }
    // Compatibility storage for legacy /api/* plugin calls. Keep each endpoint payload in the JSON snapshot.
    if (path.startsWith('/api/') && method === 'POST') {
      const payload = await body(req); const state = await readState(); const data = normalizeData(state.data);
      const bucket = path.replaceAll('/', '_'); data.apiData[bucket] ||= {};
      const identity = String(payload.uuid || payload.id || payload.serverId || crypto.randomUUID());
      data.apiData[bucket][identity] = payload;
      await writeState(data); return send(res, 200, { success: true });
    }
    if (path.startsWith('/api/') && method === 'DELETE') return send(res, 200, { success: true });
    return send(res, 404, { error: 'not_found', path, method });

    async function deleteRecord(type, id) {
      if (!['category', 'product'].includes(type) || !id) return send(res, 400, { error: 'invalid_delete_type_or_id' });
      const state = await readState(); const data = normalizeData(state.data);
      const field = type === 'category' ? 'categories' : 'products'; const key = type === 'category' ? 'name' : 'id';
      data[field] = data[field].filter(x => String(idOf(x, key) ?? '').toLowerCase() !== id.toLowerCase());
      data.tombstones = data.tombstones.filter(t => !(t.type === type && String(t.id).toLowerCase() === id.toLowerCase()));
      data.tombstones.push({ type, id, deletedAt: Date.now(), deletedBy: serverId });
      const result = await writeState(data); return send(res, 200, { success: true, revision: result.revision });
    }
  } catch (err) {
    console.error('[GoldenStore API]', err);
    return send(res, 500, { error: 'internal_server_error', message: process.env.NODE_ENV === 'development' ? err.message : undefined });
  }
}
