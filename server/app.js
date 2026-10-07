import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import multer from 'multer';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { createUploads } from './storage.js';
export function createApp({ services, auth, storage, cfg }) {
  const app = express(),
    uploads = createUploads(services, storage);
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'", 'https://apis.google.com'],
          connectSrc: [
            "'self'",
            'https://*.googleapis.com',
            'https://*.firebaseio.com',
            'https://*.firebaseapp.com',
            'wss:',
          ],
          frameSrc: ['https://*.firebaseapp.com'],
          imgSrc: ["'self'", 'blob:', 'https:'],
          styleSrc: ["'self'", "'unsafe-inline'"],
          objectSrc: ["'none'"],
        },
      },
      crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' },
    }),
  );
  app.use(express.json({ limit: '24kb' }));
  app.get('/health/live', (req, res) => res.json({ ok: true }));
  app.get('/health/ready', async (req, res) => {
    try {
      await services.db.command({ ping: 1 });
      res.json({ ok: true });
    } catch {
      res.status(503).json({ ok: false });
    }
  });
  app.get('/api/config', (req, res) =>
    res.set('Cache-Control', 'no-store').json({ firebase: cfg.browserFirebase }),
  );
  app.use(
    '/api',
    rateLimit({ windowMs: 60000, limit: 180, standardHeaders: 'draft-8', legacyHeaders: false }),
    auth.http,
    (req, res, next) => {
      res.set('Cache-Control', 'private, no-store');
      next();
    },
  );
  const route = (method, path, fn) =>
    app[method](path, async (req, res) => res.json(await fn(req, req.identity.userId)));
  route('get', '/api/me', (r, u) => services.me(u));
  route('patch', '/api/me', (r, u) => services.profile(u, r.body));
  route('get', '/api/users/lookup', (r) => services.lookup(r.query));
  route('get', '/api/conversations', (r, u) => services.list(u, r.query));
  route('post', '/api/conversations/direct', (r, u) => services.direct(u, r.body));
  route('post', '/api/conversations/group', (r, u) => services.group(u, r.body));
  route('get', '/api/conversations/:id', (r, u) => services.details(r.params.id, u));
  route('patch', '/api/conversations/:id', (r, u) =>
    services.mutate(r.params.id, u, 'rename', r.body),
  );
  route('post', '/api/conversations/:id/members', (r, u) =>
    services.mutate(r.params.id, u, 'add', r.body),
  );
  route('delete', '/api/conversations/:id/members/:userId', (r, u) =>
    services.mutate(r.params.id, u, 'remove', {}, r.params.userId),
  );
  route('patch', '/api/conversations/:id/members/:userId', (r, u) =>
    services.mutate(r.params.id, u, 'role', r.body, r.params.userId),
  );
  route('post', '/api/conversations/:id/transfer-owner', (r, u) =>
    services.mutate(r.params.id, u, 'transfer', r.body),
  );
  route('patch', '/api/conversations/:id/preferences', (r, u) =>
    services.preferences(r.params.id, u, r.body),
  );
  route('get', '/api/conversations/:id/messages', (r, u) =>
    services.history(r.params.id, u, r.query),
  );
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 0 },
  });
  // Reject nonmembers before accepting expensive multipart bodies.
  app.post(
    '/api/conversations/:id/uploads',
    rateLimit({ windowMs: 60000, limit: 10 }),
    async (req, res, next) => {
      try {
        await services.access(req.params.id, req.identity.userId);
        next();
      } catch (e) {
        next(e);
      }
    },
    upload.single('image'),
    async (req, res) =>
      res.json(await uploads.upload(req.params.id, req.identity.userId, req.file)),
  );
  app.get('/api/media/:id', async (req, res) => {
    const body = await uploads.media(req.params.id, req.identity.userId);
    res.type('image/webp');
    try {
      await pipeline(body, res);
    } catch (e) {
      if (!res.headersSent) throw e;
    }
  });
  app.use('/api', (req, res) => res.status(404).json({ error: 'API endpoint not found' }));
  const dist = resolve(import.meta.dirname, '../client/dist');
  app.use(
    '/assets',
    express.static(resolve(dist, 'assets'), { immutable: true, maxAge: '1y', fallthrough: false }),
  );
  app.use(express.static(dist, { index: false, maxAge: 0 }));
  app.use((req, res) => {
    if (
      req.method === 'GET' &&
      req.headers.accept?.includes('text/html') &&
      !req.path.startsWith('/socket.io') &&
      !/\.[a-z\d]+$/i.test(req.path) &&
      existsSync(resolve(dist, 'index.html'))
    )
      return res.set('Cache-Control', 'no-cache').sendFile(resolve(dist, 'index.html'));
    res.status(404).json({ error: 'Not found' });
  });
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    const status = err.status || (err.code === 'LIMIT_FILE_SIZE' ? 413 : 500);
    if (status >= 500) console.error('Request failed', { name: err.name, code: err.code });
    res
      .status(status)
      .json({ error: status >= 500 ? 'Service temporarily unavailable' : err.message });
  });
  return app;
}
