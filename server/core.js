import { ObjectId } from 'mongodb';
import { z } from 'zod';
export class AppError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
export const fail = (status, message) => {
  throw new AppError(status, message);
};
export const oid = (value) => {
  if (typeof value !== 'string' || !/^[a-f\d]{24}$/i.test(value)) fail(400, 'Invalid ID');
  return new ObjectId(value);
};
export const same = (a, b) => String(a) === String(b);
export const publicUser = (u) => ({
  id: String(u._id),
  displayName: u.displayName,
  avatarUrl: u.avatarUrl,
  handle: u.handle,
});
export const json = (value) => JSON.parse(JSON.stringify(value));
export const parse = (schema, value) => {
  const r = schema.safeParse(value);
  if (!r.success)
    fail(400, r.error.issues.map((x) => `${x.path.join('.')}: ${x.message}`).join('; '));
  return r.data;
};
export const idSchema = z.string().regex(/^[a-f\d]{24}$/i);
export const titleSchema = z.string().trim().min(1).max(100);
export const messageSchema = z.object({
  conversationId: idSchema,
  clientMessageId: z.string().uuid(),
  type: z.enum(['text', 'image']),
  content: z.string().max(4000).optional(),
  attachmentId: idSchema.optional(),
});
export const profileSchema = z.object({
  displayName: z.string().trim().min(1).max(60).optional(),
  handle: z
    .string()
    .regex(/^[a-z0-9_]{3,24}$/)
    .optional(),
  avatarUrl: z
    .string()
    .url()
    .max(2048)
    .refine((x) => new URL(x).protocol === 'https:')
    .nullable()
    .optional(),
});
export class KeyLock {
  #tails = new Map();
  async run(key, fn) {
    key = String(key);
    const prior = this.#tails.get(key) || Promise.resolve();
    let release;
    const next = new Promise((r) => {
      release = r;
    });
    this.#tails.set(key, next);
    await prior;
    try {
      return await fn();
    } finally {
      release();
      if (this.#tails.get(key) === next) this.#tails.delete(key);
    }
  }
}
export class Limiter {
  #entries = new Map();
  constructor(max, windowMs) {
    this.max = max;
    this.windowMs = windowMs;
  }
  take(key) {
    const now = Date.now();
    for (const [k, v] of this.#entries) if (v.until <= now) this.#entries.delete(k);
    const e = this.#entries.get(key) || { n: 0, until: now + this.windowMs };
    if (++e.n > this.max) fail(429, 'Please slow down');
    this.#entries.set(key, e);
  }
}
