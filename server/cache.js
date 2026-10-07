import { createClient } from 'redis';
export async function createCache(cfg) {
  let redis;
  if (cfg.redisUrl) {
    redis = createClient({
      url: cfg.redisUrl,
      disableOfflineQueue: true,
      socket: {
        connectTimeout: 1000,
        reconnectStrategy: (retries) => Math.min(1000 + retries * 500, 10000),
      },
    });
    redis.on('error', () => {});
    redis.connect().catch(() => {});
  }
  const localCooldown = new Map();
  async function command(fn) {
    if (!redis?.isReady) return undefined;
    let timer;
    try {
      return await Promise.race([
        fn(redis),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('Cache timeout')), 250);
        }),
      ]);
    } catch {
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  }
  const key = (id) => `chat:v2:conversation:${id}:latest`;
  return {
    async get(id) {
      if (!cfg.cacheEnabled) return null;
      const value = await command((r) => r.get(key(id)));
      if (!value) return null;
      try {
        return JSON.parse(value);
      } catch {
        return null;
      }
    },
    async set(id, value) {
      if (cfg.cacheEnabled) await command((r) => r.set(key(id), JSON.stringify(value), { EX: 15 }));
    },
    async invalidate(id) {
      await command((r) => r.del(key(id)));
    },
    async buzz(id, userId) {
      const k = `chat:v2:buzz:${id}:${userId}`;
      const now = Date.now();
      for (const [key, until] of localCooldown) if (until <= now) localCooldown.delete(key);
      if ((localCooldown.get(k) || 0) > now) return false;
      const result = await command((r) => r.set(k, '1', { NX: true, EX: 45 }));
      if (result === null) return false;
      localCooldown.set(k, now + 45000);
      return true;
    },
    async close() {
      if (redis?.isOpen) redis.destroy();
    },
  };
}
