import { createServer } from 'node:http';
import { config } from './config.js';
import { connectDatabase } from './db.js';
import { createAuth, firebaseVerifier } from './auth.js';
import { createCache } from './cache.js';
import { createServices } from './services.js';
import { createStorage } from './storage.js';
import { createApp } from './app.js';
import { attachSockets } from './sockets.js';
const cfg = config();
const { db, client } = await connectDatabase(cfg.mongoUri, cfg.dbName);
const cache = await createCache(cfg),
  services = createServices({ db, client, cache }),
  storage = createStorage(cfg),
  auth = createAuth(db, firebaseVerifier(cfg));
const server = createServer(createApp({ services, storage, auth, cfg }));
const io = attachSockets(server, { services, auth, cfg });
let cleaning = false;
const cleanup = async () => {
  if (cleaning) return;
  cleaning = true;
  try {
    await services.cleanup(storage);
  } catch (e) {
    console.error('Cleanup failed', { name: e.name, code: e.code });
  } finally {
    cleaning = false;
  }
};
const timer = setInterval(cleanup, 60000);
timer.unref();
cleanup();
server.listen(cfg.port, '0.0.0.0', () => console.log(`Chat listening on port ${cfg.port}`));
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  clearInterval(timer);
  const deadline = setTimeout(() => process.exit(1), 10000);
  io.close();
  await new Promise((r) => server.close(r));
  await cache.close();
  await client.close();
  clearTimeout(deadline);
}
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
