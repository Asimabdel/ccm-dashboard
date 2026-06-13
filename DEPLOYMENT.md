# Deploying ccm-dashboard to Vercel

This app is a Vite (React) frontend + an Express/tRPC backend backed by MySQL.
On Vercel the frontend is served from the CDN and the backend runs as a single
serverless function.

## How it's wired

| Piece | File | Notes |
| ----- | ---- | ----- |
| Serverless API | [`api/index.ts`](api/index.ts) | Exports the Express app (no `listen()`). |
| Shared app builder | [`server/_core/app.ts`](server/_core/app.ts) | Used by both the local server and the function. |
| Routing / build config | [`vercel.json`](vercel.json) | `vite build` → `dist/public`; rewrites `/api/*` and `/manus-storage/*` to the function; everything else falls back to `index.html` (SPA). |
| Env var reference | [`.env.example`](.env.example) | Every variable the app reads. |

## Step 1 — Get a MySQL database

Vercel does not host databases. Pick one that's reachable over the internet and
**signs a BAA** if you will store real PHI (this app is HIPAA-oriented):

| Option | Free tier | BAA / HIPAA | Notes |
| ------ | --------- | ----------- | ----- |
| **AWS RDS for MySQL** | No (low-cost t-class) | Yes (AWS BAA) | Best fit when real PHI is involved. |
| **PlanetScale** | No (~$39/mo+) | On paid plans | MySQL-compatible, great with serverless. |
| **Railway MySQL** | Trial credit | No BAA | Easiest for staging / non-PHI demos. |
| **TiDB Cloud Serverless** | Yes | No BAA | MySQL-compatible, generous free tier; good for testing. |

Copy the connection string into `DATABASE_URL` (see `.env.example` for the format).

> ⚠️ For production PHI you must have a signed BAA with **both** your database
> host **and** your application host. Vercel does **not** offer a BAA on Hobby/Pro
> plans. If a BAA is required, host the server on a platform that signs one
> (AWS, Railway Pro, Render, Fly.io) instead of Vercel.

## Step 2 — Create the schema

From a machine with `DATABASE_URL` set to the new database:

```bash
pnpm db:push     # runs drizzle-kit generate + migrate
pnpm tsx server/seed.ts   # optional: seed demo data
```

## Step 3 — Deploy

### Option A — Vercel dashboard (recommended)
1. Push this branch to GitHub.
2. In the Vercel dashboard: **Add New → Project → Import** `Asimabdel/ccm-dashboard`.
3. Vercel reads `vercel.json` automatically — leave build settings as detected.
4. **Settings → Environment Variables**: add every value from `.env.example`
   (at minimum `DATABASE_URL`, `JWT_SECRET`, `OWNER_OPEN_ID`).
5. **Deploy.** Vercel auto-deploys every future push to `main`.

### Option B — Vercel CLI
```bash
npm i -g vercel
vercel login
vercel link
vercel env add DATABASE_URL production   # repeat for each variable
vercel --prod
```

## Notes & caveats

- **Serverless state is per-instance.** The in-memory login-attempt lockout in
  [`server/db.ts`](server/db.ts) and the cached DB connection live only for a warm
  instance, so brute-force protection is best-effort across instances. Move it to
  the database or a shared store (e.g. Upstash Redis) if you need hard guarantees.
- **DB connections.** Each cold start opens a new mysql2 connection. On a
  connection-limited database, prefer a provider with a serverless/HTTP driver or
  a pooler to avoid exhausting connections under load.
- **Manus OAuth.** `OAUTH_SERVER_URL` / `VITE_APP_ID` point at the Manus platform.
  Off-platform, the Manus OAuth sign-in won't complete, but email + password
  worker login works independently.
