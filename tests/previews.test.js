import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { ObjectId } from 'mongodb';
import {
  publicAddress,
  publicTarget,
  publicGet,
  metadata,
  createPreviews,
} from '../server/previews.js';
import { extractLinks } from '../client/links.js';
const resolve = async () => [{ address: '93.184.216.34', family: 4 }];

test('links preserve query parameters, trim punctuation, reject credentials and retain text positions', () => {
  const text =
    'See (https://example.com/article?a=1&b=two), https://example.com/a(b). <script>bad</script>';
  const links = extractLinks(text);
  assert.deepEqual(
    links.map((x) => x.url),
    ['https://example.com/article?a=1&b=two', 'https://example.com/a(b)'],
  );
  for (const link of links) assert.equal(text.slice(link.start, link.end), link.text);
  assert.equal(extractLinks('https://user:pass@example.com/').length, 0);
});
test('metadata handles entities, attribute order, relative images and standard fallbacks', () => {
  const data = metadata(
    `<title>Fallback</title><meta content="A &amp; B" property="og:title"><meta name='description' content='Some &quot;words&quot;'>
    <meta property='og:image' content='/cover.png'><meta property='og:site_name' content='Example'>`,
    'https://example.com/article',
  );
  assert.equal(data.title, 'A & B');
  assert.equal(data.description, 'Some "words"');
  assert.equal(data.imageUrl, 'https://example.com/cover.png');
  assert.equal(metadata('<title>Only title</title>', 'https://example.com').title, 'Only title');
  assert.equal(metadata('<p>No title</p>', 'https://example.com'), null);
});
test('blocks private, loopback, mapped IPv6, reserved addresses and unsupported URLs', async () => {
  for (const address of [
    '127.0.0.1',
    '10.1.2.3',
    '172.16.1.1',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '::1',
    'fc00::1',
    'fe80::1',
    '::ffff:127.0.0.1',
  ]) {
    assert.equal(publicAddress(address), false, address);
    await assert.rejects(
      publicTarget(`http://${address.includes(':') ? `[${address}]` : address}/`),
    );
  }
  for (const url of [
    'file:///etc/passwd',
    'http://user:pass@example.com',
    'https://example.com:8443',
  ])
    await assert.rejects(publicTarget(url, resolve));
  await assert.rejects(
    publicTarget('http://example.com', async () => [
      { address: '93.184.216.34', family: 4 },
      { address: '127.0.0.1', family: 4 },
    ]),
  );
  assert.equal(
    (await publicTarget('https://example.com', resolve)).address.address,
    '93.184.216.34',
  );
});
function responseRequest({
  status = 200,
  headers = { 'content-type': 'text/html' },
  body = '<title>Example</title>',
  inspect,
} = {}) {
  return (url, options, callback) => {
    const req = new EventEmitter();
    req.setTimeout = () => req;
    inspect?.(url, options);
    const res = Readable.from([Buffer.from(body)]);
    res.statusCode = status;
    res.headers = headers;
    queueMicrotask(() => callback(res));
    return req;
  };
}
test('pins outgoing DNS lookup and refuses private redirect targets', async () => {
  let pinned;
  const result = await publicGet('https://example.com', {
    resolve,
    request: responseRequest({
      inspect: (_url, options) => {
        options.lookup('example.com', { all: true }, (_err, addresses) => {
          pinned = addresses[0].address;
        });
        assert.equal(options.agent, false);
        assert.equal(options.headers.Authorization, undefined);
      },
    }),
  });
  assert.equal(pinned, '93.184.216.34');
  assert.match(result.body.toString(), /Example/);
  await assert.rejects(
    publicGet('https://example.com', {
      resolve,
      request: responseRequest({ status: 302, headers: { location: 'http://127.0.0.1/secrets' } }),
    }),
  );
});
test('rejects non-HTML, oversized responses, redirect loops and stalled DNS', async () => {
  for (const options of [
    { headers: { 'content-type': 'application/json' } },
    { body: 'x'.repeat(512 * 1024 + 1) },
    { status: 302, headers: { location: '/again' } },
  ])
    await assert.rejects(
      publicGet('https://example.com', { resolve, request: responseRequest(options) }),
    );
  const controller = new AbortController();
  const blocked = publicGet('https://example.com', {
    resolve: () => new Promise(() => {}),
    signal: controller.signal,
  });
  controller.abort(new Error('Deadline'));
  await assert.rejects(blocked, /Deadline/);
});
const cid = new ObjectId(),
  mid = new ObjectId();
function serviceStub(content = 'https://example.com/article') {
  return {
    calls: 0,
    access: async function () {
      this.calls++;
      return { c: { _id: cid, lastSeq: 1 } };
    },
    db: {
      collection: () => ({
        findOne: async (filter) => {
          assert.equal(String(filter._id), String(mid));
          assert.equal(filter.type, 'text');
          assert.equal(filter.seq.$gte, 1);
          return { content };
        },
      }),
    },
  };
}
test('deduplicates preview fetches, caches metadata and rechecks membership', async () => {
  const services = serviceStub();
  let calls = 0;
  const previews = createPreviews({
    services,
    get: async (url) => {
      calls++;
      return { url, body: Buffer.from('<title>Page</title>') };
    },
  });
  const [a, b] = await Promise.all([
    previews.message(String(cid), String(mid), 'u'),
    previews.message(String(cid), String(mid), 'u'),
  ]);
  assert.equal(a.preview.title, 'Page');
  assert.deepEqual(a, b);
  assert.equal(calls, 1);
  await previews.message(String(cid), String(mid), 'u');
  assert.equal(calls, 1);
  assert.equal(services.calls, 6);
});
test('failed sites and missing metadata return a usable null preview', async () => {
  for (const get of [
    async () => {
      throw Error('Offline');
    },
    async (url) => ({ url, body: Buffer.from('<p>Missing</p>') }),
  ]) {
    const previews = createPreviews({ services: serviceStub(), get });
    assert.deepEqual(await previews.message(String(cid), String(mid), 'u'), { preview: null });
  }
});
test('membership revocation during fetch prevents preview delivery', async () => {
  const services = serviceStub();
  services.access = async function () {
    if (++this.calls > 1) throw Object.assign(Error('Removed'), { status: 403 });
    return { c: { _id: cid, lastSeq: 1 } };
  };
  const previews = createPreviews({
    services,
    get: async (url) => ({ url, body: Buffer.from('<title>Page</title>') }),
  });
  await assert.rejects(previews.message(String(cid), String(mid), 'u'), (e) => e.status === 403);
});
