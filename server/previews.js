import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import http from 'node:http';
import https from 'node:https';
import ipaddr from 'ipaddr.js';
import { load } from 'cheerio';
import sharp from 'sharp';
import { extractLinks } from '../client/links.js';
import { oid, fail } from './core.js';

export function publicAddress(address) {
  try {
    return ipaddr.process(address).range() === 'unicast';
  } catch {
    return false;
  }
}
export async function publicTarget(value, resolve = lookup) {
  const url = new URL(value);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.port ||
    url.href.length > 2048
  )
    throw new Error('Unsupported preview URL');
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(hostname)
    ? [{ address: hostname, family: isIP(hostname) }]
    : await resolve(hostname, { all: true });
  if (!addresses.length || addresses.some((entry) => !publicAddress(entry.address)))
    throw new Error('Preview address unavailable');
  return { url, address: addresses[0] };
}
// Validate each redirect and pin the socket to the validated DNS result.
export async function publicGet(value, { signal, image = false, resolve = lookup, request } = {}) {
  let current = value;
  for (let redirect = 0; redirect <= 3; redirect++) {
    const { url, address } = await new Promise((accept, reject) => {
      const aborted = () => reject(signal.reason);
      if (signal?.aborted) return aborted();
      signal?.addEventListener('abort', aborted, { once: true });
      publicTarget(current, resolve)
        .then(accept, reject)
        .finally(() => signal?.removeEventListener('abort', aborted));
    });
    signal?.throwIfAborted();
    const result = await new Promise((accept, reject) => {
      const req = (request || (url.protocol === 'https:' ? https : http).get)(
        url,
        {
          agent: false,
          signal,
          maxHeaderSize: 16384,
          lookup: (_host, options, callback) =>
            options.all
              ? callback(null, [address])
              : callback(null, address.address, address.family),
          headers: {
            'User-Agent': 'Relay-LinkPreview/1.0',
            Accept: image
              ? 'image/jpeg,image/png,image/webp,image/gif'
              : 'text/html,application/xhtml+xml',
            'Accept-Encoding': 'identity',
          },
        },
        (res) => {
          const status = res.statusCode;
          if ([301, 302, 303, 307, 308].includes(status)) {
            const location = res.headers.location;
            res.destroy();
            try {
              if (!location) throw new Error('Invalid redirect');
              return accept({ redirect: new URL(location, url).href });
            } catch (error) {
              return reject(error);
            }
          }
          const type = res.headers['content-type'] || '';
          const allowed = image
            ? /^image\/(jpeg|png|webp|gif)(;|$)/i
            : /^(text\/html|application\/xhtml\+xml)(;|$)/i;
          const limit = image ? 1024 * 1024 : 4 * 1024 * 1024;
          if (
            status !== 200 ||
            !allowed.test(type) ||
            Number(res.headers['content-length']) > limit ||
            (res.headers['content-encoding'] && res.headers['content-encoding'] !== 'identity')
          ) {
            res.destroy();
            return reject(new Error('Unsupported preview response'));
          }
          const chunks = [];
          let length = 0;
          res.on('data', (chunk) => {
            length += chunk.length;
            if (length > limit) {
              res.destroy(new Error('Preview too large'));
              return;
            }
            chunks.push(chunk);
          });
          res.on('error', reject);
          res.on('aborted', () => reject(new Error('Preview interrupted')));
          res.on('end', () => accept({ body: Buffer.concat(chunks), url: url.href }));
        },
      );
      req.setTimeout(4000, () => req.destroy(new Error('Preview timeout')));
      req.on('error', reject);
    });
    if (!result.redirect) return result;
    current = result.redirect;
  }
  throw new Error('Too many preview redirects');
}
export function metadata(html, value) {
  const $ = load(html);
  const meta = (keys) => {
    for (const key of keys) {
      const tag = $('meta')
        .filter(
          (_i, el) => ($(el).attr('property') || $(el).attr('name') || '').toLowerCase() === key,
        )
        .first();
      if (tag.attr('content')?.trim()) return tag.attr('content').trim();
    }
    return '';
  };
  const clean = (text, max) => String(text).replace(/\s+/g, ' ').trim().slice(0, max);
  const title = clean(meta(['og:title', 'twitter:title']) || $('title').first().text(), 200);
  if (!title) return null;
  let imageUrl = null;
  try {
    const candidate = new URL(meta(['og:image:secure_url', 'og:image', 'twitter:image']), value);
    if (
      meta(['og:image:secure_url', 'og:image', 'twitter:image']) &&
      ['http:', 'https:'].includes(candidate.protocol)
    )
      imageUrl = candidate.href;
  } catch {}
  return {
    title,
    description: clean(meta(['og:description', 'twitter:description', 'description']), 300),
    siteName: clean(meta(['og:site_name']) || new URL(value).hostname, 100),
    imageUrl,
  };
}
export function createPreviews({ services, get = publicGet }) {
  const cache = new Map();
  const pending = new Map();
  let active = 0;
  const waiting = [];
  async function acquire() {
    if (active < 4) {
      active++;
      return;
    }
    await new Promise((resolve) => waiting.push(resolve));
  }
  function release() {
    const next = waiting.shift();
    if (next) next();
    else active--;
  }
  async function unfurl(url) {
    const hit = cache.get(url);
    if (hit && hit.expires > Date.now()) return hit.data;
    if (pending.has(url)) return pending.get(url);
    if (pending.size >= 100) return null;
    const work = (async () => {
      await acquire();
      let data = null;
      const signal = AbortSignal.timeout(8000);
      try {
        const result = await get(url, { signal });
        const parsed = metadata(result.body.toString('utf8'), result.url);
        if (parsed) {
          data = {
            url,
            title: parsed.title,
            description: parsed.description,
            siteName: parsed.siteName,
            image: null,
          };
          if (parsed.imageUrl) {
            try {
              const image = await get(parsed.imageUrl, { signal, image: true });
              const buffer = await sharp(image.body, { limitInputPixels: 16000000 })
                .resize({ width: 600, height: 400, fit: 'inside', withoutEnlargement: true })
                .webp({ quality: 70 })
                .toBuffer();
              if (buffer.length <= 150000)
                data.image = `data:image/webp;base64,${buffer.toString('base64')}`;
            } catch {}
          }
        }
      } catch {
      } finally {
        release();
      }
      cache.delete(url);
      cache.set(url, { data, expires: Date.now() + (data ? 3600000 : 60000) });
      while (cache.size > 200) cache.delete(cache.keys().next().value);
      return data;
    })();
    pending.set(url, work);
    try {
      return await work;
    } finally {
      pending.delete(url);
    }
  }
  return {
    async message(conversationId, messageId, userId) {
      const { c } = await services.access(conversationId, userId);
      const message = await services.db.collection('messages').findOne({
        _id: oid(messageId),
        conversationId: c._id,
        type: 'text',
        seq: { $gte: Math.max(1, c.lastSeq - 999), $lte: c.lastSeq },
      });
      if (!message) fail(404, 'Message unavailable');
      const url = extractLinks(message.content)[0]?.url;
      const preview = url ? await unfurl(url) : null;
      // A member may have been removed while the remote page was loading.
      await services.access(conversationId, userId);
      return { preview };
    },
  };
}
