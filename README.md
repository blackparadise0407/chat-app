# Relay private chat

A runnable implementation of `chat-app-implementation-plan-v2.md`. One Node.js process serves the Vite-built vanilla JavaScript SPA, Express API and Socket.IO. MongoDB is authoritative; Redis is optional. Uploaded images use a private S3-compatible bucket.

The supplied workspace contained the plan only. This is a new standalone application, not a patch to existing source. Existing custom sounds, icons, GIF integrations and encrypted-file persistence were not available to migrate; the four themes, chat grouping, photos/lightbox, synthesized notification sound, favicon badge and buzz were recreated.

## Start locally

Requirements: Node.js 22 or newer, MongoDB Atlas or a local replica set, a Firebase project with Google sign-in enabled. Configure S3 only if using photo uploads.

```sh
npm ci
cp .env.example .env
# Fill .env with your values.
npm run dev
```

Open `http://localhost:5173`. Vite proxies `/api` and `/socket.io` (polling and WebSocket upgrades) to Node on port 3000. Set the Firebase authorized domains to include `localhost`. Create profiles by signing in, then share the exact public handle or app ID shown in Profile. No email directory is exposed.

A MongoDB standalone server cannot run the transactions used here. For an existing local Mongo installation, start it with `mongod --replSet rs0`, run `rs.initiate()` once using `mongosh`, and use the example replica-set URI. Use authenticated MongoDB access outside local development.

## Production / Render

```sh
npm ci
npm run build
NODE_ENV=production npm start
```

`render.yaml` defines one Render Node Web Service. Push these files to your repository, connect the service, then populate its environment variables. Build command: `npm ci && npm run build`; start command: `npm start`; readiness path: `/health/ready`. The server binds to `0.0.0.0` and Render's assigned `PORT`.

Set `APP_ORIGIN` to the exact HTTPS service origin and add its hostname to Firebase Authentication's authorized domains. `FIREBASE_AUTH_DOMAIN` should normally remain your Firebase project's `.firebaseapp.com` domain. Firebase browser values are public configuration, returned at `/api/config`; Admin, MongoDB, Redis and storage secrets never enter the frontend bundle. Firebase Admin accepts a one-line service-account JSON in `FIREBASE_ADMIN_CREDENTIALS`, or application default credentials via `GOOGLE_APPLICATION_CREDENTIALS`.

Use a private S3-compatible bucket with no public access. Supply `S3_BUCKET`, `S3_REGION`, `S3_ENDPOINT` when required, and credentials scoped to the bucket. For AWS S3 use the real AWS region and omit `S3_ENDPOINT`; for R2 use `auto` and the account S3 endpoint. Browser requests use authenticated `/api/media/:id`, not permanent public or signed URLs. Missing S3 configuration disables uploads without blocking text chat. Configure provider backups for MongoDB; no infrastructure or secrets are provisioned by this project.

Optional: set `REDIS_URL` and `CACHE_ENABLED=true`. Latest 50-message pages have a 15-second TTL; authoritative recovery and older history bypass the cache. Redis commands time out after 250 ms and fall back to MongoDB or process-local cooldowns. Presence is process-local and combines tabs/devices. There is no Redis adapter: this application must remain single-instance.

## Implemented behavior

- Verified Firebase ID tokens for HTTP and socket connections, including revoked/disabled checks. Socket expiry disconnects automatically; server checks revocation every four minutes. Browser refreshes tokens and reconnects. Firebase logout is synchronized across tabs and clears account-specific state. Logout alone does not globally revoke a stolen token.
- Transactional direct/group creation and membership changes; public handles; group admins, ownership transfer, leaving/removal; mute and archive. Direct participants cannot change membership. Groups are limited to 50 active members; added members immediately gain retained-history access.
- Transactional, ordered messages and retry-ID deduplication. Sender identity is server-derived. Reusing a retained message's retry ID with different content is rejected. Dispatch occurs after commit and within the per-conversation process lock. This is best-effort live delivery with durable MongoDB recovery, not exactly-once delivery.
- Latest/older history, high-water-bound reconnect recovery, live/history merging and gap repair. At most 1,000 retained messages per conversation are visible, even before the periodic cleanup physically deletes earlier records. Retry deduplication exists for retained messages; expired records are not a permanent retry ledger.
- Membership read-through positions with monotonic updates, read display, sender-excluded and retention-aware unread counts. The browser advances reads only when focused, visible, at the bottom, and its loaded timeline is contiguous. Re-added members' initial baseline is excluded from receipt counts.
- Private JPEG/PNG/WebP uploads, byte decoding/signature validation, dimensions/pixel/5 MiB limits, normalization to static WebP, and owner/conversation binding. A reserved attachment record permits cleanup after a crash during storage upload. Abandoned/unreferenced uploads receive a 24-hour grace period.
- Typing expiry, shared-peer presence, 45-second buzz cooldown, sounds, browser notifications while open, four themes and responsive screens. Notifications reveal no message body. Links are rendered safely without server-side URL fetching or third-party preview scraping.
- SPA routing, nested refresh, API/asset JSON 404s, hashed-asset caching, no-store private responses, request limits, readiness checks, cleanup and graceful shutdown.

## Verification

```sh
npm run check
npm run build
npm test
npx playwright install chromium
npm run test:browser
# Or, after installing Chromium:
npm run test:all
```

Backend integration tests create a real temporary MongoDB replica set using `mongodb-memory-server` (the first run downloads MongoDB 7.0.14). Its test-only `--nounixsocket` option supports environments that prohibit Unix sockets. No production database or Firebase account is used by tests. Tests cover concurrent direct creation, sender spoofing, retry conflicts, transaction rollback, permissions, rejoin/ownership, reads, retention isolation, private image binding/revocation, HTTP routing, sockets, Redis failure, commit-before-broadcast recovery and membership/removal dispatch ordering.

Playwright exercises the actual client module with isolated Firebase/socket/API adapters supplied only by its test server. It covers sign-in navigation, back/forward, one socket across screens, safe text rendering, canonical sends, retries across navigation, removal, themes, nested refresh, not-found, logout and mobile layout. It does not replace a live-provider end-to-end test. Optionally use `PLAYWRIGHT_CHROMIUM_EXECUTABLE` to select an existing Chromium binary.

Before live use, verify Google sign-in using your Firebase project, a two-account conversation and restart/reconnect against your MongoDB deployment, and upload/access using your private bucket. Enable Redis only after confirming the uncached path. These live-provider checks require credentials and were not performed in the supplied workspace.

## Legacy migration and deferred work

No legacy data was imported. Preserve the old encrypted file and its real key offline. A legacy importer cannot be written faithfully without the original record format/encryption scheme, a verified destination group and member list. The default policy in the plan retains that public history as an offline backup; do not copy it into private chats automatically.

The plan's deferred features remain deferred: invitation acceptance, blocking, group deletion, editing/deleting messages, permanent archives, historical membership audit, end-to-end encryption, closed-tab push, durable outbox and multiple instances. No deployment has been performed.

## Layout

```text
server/
  core.js       validation, errors, process locks and rate limits
  config.js     environment configuration
  db.js         connections, indexes, bounded transaction retries
  auth.js       Firebase verification and user mapping
  services.js   conversations, membership, messages, reads, history, retention
  cache.js      optional Redis latest-page cache and buzz cooldown
  storage.js    private storage, uploads and media authorization
  sockets.js    realtime authentication, delivery and presence
  app.js        HTTP API, security headers and production SPA routes
  index.js      startup, cleanup, graceful shutdown
client/         routed vanilla JavaScript SPA and four themes
scripts/        source syntax verification
tests/          MongoDB/socket/HTTP integration and browser tests
render.yaml     single-instance Render service definition
```
