# GoldenStore — Vercel Node.js API

A GitHub-ready Node.js serverless API for GoldenStore. It uses PostgreSQL for durable state (no Redis and no Node.js process running continuously). Designed to accept the plugin's `x-api-key` authentication and existing API paths.

## Deploy to Vercel

1. Create a GitHub repository and upload the contents of this folder to its root.
2. Create a PostgreSQL database (Neon is a convenient hosted option) and copy its pooled connection string.
3. Import the GitHub repository into Vercel.
4. In **Vercel → Project → Settings → Environment Variables**, add:
   - `DATABASE_URL` = your PostgreSQL connection string
   - `GOLDENSTORE_API_KEY` = a strong random secret of at least 32 characters
   - `CORS_ORIGIN` = your dashboard origin (optional; leave unset if no browser dashboard)
5. Redeploy. The API creates its tables automatically on first authenticated request.
6. Test `GET https://YOUR-PROJECT.vercel.app/api/v1/data` with header `x-api-key: YOUR_SECRET`.

Generate a key locally with `openssl rand -hex 32`.

## API

All endpoints require `x-api-key: <same secret>` (or `Authorization: Bearer <secret>`).

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/v1/data` | Get complete JSON snapshot |
| POST | `/api/v1/data` | Replace complete snapshot |
| POST | `/api/v1/sync` | Paper HELLO/UPDATE handshake; returns snapshot |
| GET | `/api/v1/servers` | List servers that have checked in |
| POST | `/api/v1/data/delete` | Delete category/product and create tombstone |
| GET | `/api/store/catalog` | Legacy catalog read |
| POST | `/api/store/catalog/sync` | Legacy full snapshot write |
| POST | `/api/store/product` | Upsert product by `id` |
| DELETE | `/api/store/category/:name` | Delete category |
| DELETE | `/api/store/product/:id` | Delete product |
| POST | `/api/player/sync` | Store player profile data |
| GET | `/api/commands/pending?serverId=...` | Get queued commands |
| POST | `/api/commands` | Queue a command (body may include `serverId`) |
| POST | `/api/commands/confirm/:id` | Confirm command execution |

### Sync payload

```json
{
  "op": "HELLO",
  "serverId": "lifesteal",
  "database": {
    "categories": [],
    "products": [],
    "apiData": {}
  }
}
```

Use `HELLO` for initial merge and `UPDATE` for a full snapshot update. Delete operations add tombstones so later initial merges cannot reintroduce deleted category/product records.

## Plugin configuration

Set the Paper backend's `velocity.api-url` to the deployed Vercel URL (no trailing slash) and `velocity.api-key` to the exact `GOLDENSTORE_API_KEY`. Give each Paper backend a unique `server-id`, e.g. `lifesteal`, `survival`, `factions`.

**Architecture note:** This is a hosted Node.js API/database service. It does not replace the Velocity plugin's in-memory proxy coordinator or Minecraft plugin-message channel. If your Velocity plugin is configured to bind its own REST API on port 8765, that is a separate API listener; avoid configuring two services to use the same URL/port. Point Paper's API URL to the service that is intended to be authoritative for HTTP requests.

## Local development

```bash
cp .env.example .env.local
# Fill DATABASE_URL and GOLDENSTORE_API_KEY
npm install
npx vercel dev
```

## Security and operational notes

- Keep the API key private. Do not commit `.env.local` or paste the key into public issues.
- Use HTTPS (Vercel provides it).
- Restrict database credentials and rotate the API key if exposed.
- The `servers` list records last-seen servers; it is not a real-time Minecraft liveness probe.
- The serverless API persists snapshots in PostgreSQL; it does not use the ephemeral Vercel filesystem.
