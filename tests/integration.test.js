import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { MongoClient, ObjectId } from 'mongodb';
import request from 'supertest';
import { io as clientSocket } from 'socket.io-client';
import sharp from 'sharp';
import { createIndexes } from '../server/db.js';
import { createServices } from '../server/services.js';
import { createAuth } from '../server/auth.js';
import { createApp } from '../server/app.js';
import { attachSockets } from '../server/sockets.js';
import { createUploads } from '../server/storage.js';
import { createCache } from '../server/cache.js';
import { Readable } from 'node:stream';
let repl, db, client, services, app, server, io, base, auth, storage;
const ids = Array.from({ length: 4 }, () => new ObjectId());
const [alice, bob, carol, dave] = ids;
const forbidden = (promise) => assert.rejects(promise, (e) => e.status === 403);
const text = (id, content = 'Hello', clientMessageId = randomUUID()) => ({
  conversationId: String(id),
  clientMessageId,
  type: 'text',
  content,
});
before(async () => {
  repl = await MongoMemoryReplSet.create({
    replSet: { count: 1, args: ['--nounixsocket'] },
    binary: { version: '7.0.14' },
  });
  client = new MongoClient(repl.getUri());
  await client.connect();
  db = client.db('test');
  await createIndexes(db);
  await db
    .collection('users')
    .insertMany(
      ids.map((id, i) => ({
        _id: id,
        firebaseUid: `u${i}`,
        displayName: ['Alice', 'Bob', 'Carol', 'Dave'][i],
        handle: `test${i}`,
        avatarUrl: null,
      })),
    );
  services = createServices({ db, client, cache: await createCache({ cacheEnabled: false }) });
  auth = createAuth(db, async (token) => {
    const n = Number(token);
    if (!Number.isInteger(n) || n < 0 || n > 3) throw Error('Bad token');
    return { uid: `u${n}`, exp: Math.floor(Date.now() / 1000) + 3600 };
  });
  const files = new Map();
  storage = {
    async put(k, b) {
      files.set(k, b);
    },
    async get(k) {
      return Readable.from(files.get(k));
    },
    async delete(k) {
      files.delete(k);
    },
  };
  const cfg = {
    origin: 'http://localhost:3000',
    devOrigin: 'http://localhost:5173',
    production: false,
    browserFirebase: {},
  };
  app = createApp({ services, auth, storage, cfg });
  server = createServer(app);
  io = attachSockets(server, { services, auth, cfg });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  if (io) await new Promise((r) => io.close(r));
  if (client) await client.close();
  if (repl) await repl.stop();
});
test('concurrent direct creation has exactly two memberships and one record', async () => {
  const results = await Promise.all(
    Array.from({ length: 8 }, (_, n) =>
      services.direct(n % 2 ? alice : bob, { targetUserId: String(n % 2 ? bob : alice) }),
    ),
  );
  assert.equal(new Set(results.map((x) => x._id)).size, 1);
  assert.equal(
    await db
      .collection('conversationMembers')
      .countDocuments({ conversationId: new ObjectId(results[0]._id) }),
    2,
  );
  await assert.rejects(
    services.direct(alice, { targetUserId: String(alice) }),
    (e) => e.status === 400,
  );
});
test('send derives sender, deduplicates, rejects changed retry, and denies nonmembers', async () => {
  const c = await services.direct(alice, { targetUserId: String(bob) });
  const payload = { ...text(c._id), senderId: String(carol) };
  const a = await services.send(alice, payload),
    b = await services.send(alice, payload);
  assert.equal(a._id, b._id);
  assert.equal(a.senderId, String(alice));
  await assert.rejects(
    services.send(alice, { ...payload, content: 'Changed' }),
    (e) => e.status === 409,
  );
  await forbidden(services.send(carol, text(c._id)));
  await forbidden(services.history(c._id, carol));
  assert.equal((await services.details(c._id, alice)).lastSeq, 1);
});
test('ordinary members cannot promote, remove or transfer; owner lifecycle and rejoin', async () => {
  const c = await services.group(alice, {
    title: 'Members',
    userIds: [String(bob), String(carol)],
  });
  await forbidden(services.mutate(c._id, bob, 'role', { role: 'admin' }, String(bob)));
  await forbidden(services.mutate(c._id, bob, 'remove', {}, String(carol)));
  await assert.rejects(
    services.mutate(c._id, alice, 'remove', {}, String(alice)),
    (e) => e.status === 409,
  );
  await services.send(alice, text(c._id));
  await services.mutate(c._id, alice, 'remove', {}, String(bob));
  await forbidden(services.read(c._id, bob, 1));
  await services.mutate(c._id, alice, 'add', { userId: String(bob) });
  const detail = await services.details(c._id, bob);
  assert.equal(detail.membership.joinedAfterSeq, 1);
  assert.equal(detail.membership.lastReadSeq, 1);
  assert.equal((await services.history(c._id, bob)).messages.length, 1);
  await services.mutate(c._id, alice, 'transfer', { userId: String(bob) });
  await services.mutate(c._id, alice, 'remove', {}, String(alice));
  assert.equal((await services.details(c._id, bob)).ownerId, String(bob));
});
test('failed transaction rolls back sequence and message metadata', async () => {
  const c = await services.group(alice, { title: 'Rollback', userIds: [String(bob)] });
  const proxyDb = {
    collection(name) {
      const col = db.collection(name);
      if (name === 'messages')
        col.insertOne = async () => {
          throw Error('Injected write failure');
        };
      return col;
    },
  };
  const failing = createServices({ db: proxyDb, client, cache: await createCache({}) });
  await assert.rejects(failing.send(alice, text(c._id)), /Injected/);
  const after = await services.details(c._id, alice);
  assert.equal(after.lastSeq, 0);
  assert.equal(after.lastMessageId, null);
  assert.equal(
    await db.collection('messages').countDocuments({ conversationId: new ObjectId(c._id) }),
    0,
  );
});
test('history pagination, recovery snapshot, monotonic reads and unread excludes own messages', async () => {
  const c = await services.group(alice, { title: 'History', userIds: [String(bob)] });
  for (let i = 0; i < 7; i++) await services.send(i % 2 ? alice : bob, text(c._id, `${i}`));
  const page = await services.history(c._id, alice, { limit: 3 });
  assert.deepEqual(
    page.messages.map((m) => m.seq),
    [5, 6, 7],
  );
  const older = await services.history(c._id, alice, { beforeSeq: 5, limit: 3 });
  assert.deepEqual(
    older.messages.map((m) => m.seq),
    [2, 3, 4],
  );
  const recovery = await services.history(c._id, alice, {
    afterSeq: 2,
    highWaterSeq: 5,
    limit: 100,
  });
  assert.deepEqual(
    recovery.messages.map((m) => m.seq),
    [3, 4, 5],
  );
  assert.equal((await services.list(alice)).find((x) => x._id === c._id).unread, 4);
  await services.read(c._id, alice, 7);
  await services.read(c._id, alice, 2);
  assert.equal((await services.details(c._id, alice)).membership.lastReadSeq, 7);
  assert.equal((await services.list(alice)).find((x) => x._id === c._id).unread, 0);
  await assert.rejects(services.read(c._id, alice, 999), (e) => e.status === 400);
});
test('retained window and cleanup remain conversation-scoped', async () => {
  const c = await services.group(alice, { title: 'Retention', userIds: [String(bob)] });
  const id = new ObjectId(c._id);
  await db
    .collection('messages')
    .insertMany(
      Array.from({ length: 1005 }, (_, i) => ({
        _id: new ObjectId(),
        conversationId: id,
        seq: i + 1,
        senderId: bob,
        clientMessageId: randomUUID(),
        type: 'text',
        content: 'old',
        createdAt: new Date(),
      })),
    );
  await db.collection('conversations').updateOne({ _id: id }, { $set: { lastSeq: 1005 } });
  const recovered = await services.history(c._id, alice, { afterSeq: 0 });
  assert.equal(recovered.expired, true);
  assert.equal(recovered.retainedFromSeq, 6);
  assert.equal(recovered.messages[0].seq, 6);
  assert.equal((await services.list(alice)).find((x) => x._id === c._id).unread, 1000);
  const otherCount = await db
    .collection('messages')
    .countDocuments({ conversationId: { $ne: id } });
  await services.cleanup(storage);
  assert.equal(await db.collection('messages').countDocuments({ conversationId: id }), 1000);
  assert.equal(
    await db.collection('messages').countDocuments({ conversationId: { $ne: id } }),
    otherCount,
  );
});
test('private images validate bytes, bind owner and conversation, revoke on removal', async () => {
  const c = await services.group(alice, { title: 'Images', userIds: [String(bob)] }),
    uploads = createUploads(services, storage);
  const bytes = await sharp({ create: { width: 4, height: 4, channels: 3, background: '#ff0000' } })
    .png()
    .toBuffer();
  const ref = await uploads.upload(c._id, alice, { buffer: bytes, size: bytes.length });
  await forbidden(
    services.send(bob, { ...text(c._id), type: 'image', attachmentId: ref.attachmentId }),
  );
  const other = await services.group(alice, { title: 'Other', userIds: [String(carol)] });
  await forbidden(
    services.send(alice, { ...text(other._id), type: 'image', attachmentId: ref.attachmentId }),
  );
  await services.send(alice, { ...text(c._id), type: 'image', attachmentId: ref.attachmentId });
  assert.ok(await uploads.media(ref.attachmentId, bob));
  await services.mutate(c._id, alice, 'remove', {}, String(bob));
  await forbidden(uploads.media(ref.attachmentId, bob));
  await assert.rejects(
    uploads.upload(c._id, alice, { size: 3, buffer: Buffer.from('bad') }),
    (e) => e.status === 400,
  );
});
test('HTTP auth, API/asset 404s, SPA deep links and readiness', async () => {
  assert.equal((await request(app).get('/api/me')).status, 401);
  assert.equal(
    (await request(app).get('/api/me').set('Authorization', 'Bearer revoked')).status,
    401,
  );
  assert.equal(
    (
      await request(app)
        .get('/api/missing')
        .set('Authorization', 'Bearer 0')
        .set('Accept', 'text/html')
    ).status,
    404,
  );
  const missing = await request(app).get('/assets/missing.js').set('Accept', 'text/html');
  assert.equal(missing.status, 404);
  assert.match(missing.headers['content-type'], /json/);
  const html = await request(app).get(`/conversations/${alice}`).set('Accept', 'text/html');
  assert.equal(html.status, 200);
  assert.match(html.text, /Relay/);
  assert.equal(
    (await request(app).post('/conversations/test').set('Accept', 'text/html')).status,
    404,
  );
  assert.equal((await request(app).get('/health/ready')).status, 200);
  const lookup = await request(app)
    .get('/api/users/lookup?handle=test1')
    .set('Authorization', 'Bearer 0');
  assert.equal(lookup.body.id, String(bob));
  assert.equal(lookup.body.firebaseUid, undefined);
});
const openSocket = (token) =>
  new Promise((resolve, reject) => {
    const socket = clientSocket(base, {
      auth: { token },
      transports: ['websocket'],
      reconnection: false,
    });
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', (e) => {
      socket.close();
      reject(e);
    });
  });
const ack = (s, event, p) =>
  new Promise((resolve) =>
    s.timeout(3000).emit(event, p, (e, r) => resolve(e ? { ok: false } : r)),
  );
test('socket rejects nonmembers and delivery after removal; cooldown and multi-tab reads', async () => {
  const c = await services.group(alice, { title: 'Sockets', userIds: [String(bob)] });
  const [a, b, b2, stranger] = await Promise.all(['0', '1', '1', '3'].map(openSocket));
  try {
    assert.equal(
      (await ack(stranger, 'conversation:subscribe', { conversationId: c._id })).ok,
      false,
    );
    let removedDelivery = false;
    b.on('chat_message', () => {
      removedDelivery = true;
    });
    const received = new Promise((resolve) => b2.once('read_receipt_update', resolve));
    const sent = await ack(a, 'chat_message', text(c._id));
    assert.equal(sent.ok, true);
    assert.equal(
      (await ack(b, 'messages_read', { conversationId: c._id, seq: sent.data.seq })).ok,
      true,
    );
    assert.equal((await received).seq, sent.data.seq);
    assert.equal((await ack(a, 'buzz', { conversationId: c._id })).ok, true);
    assert.equal((await ack(a, 'buzz', { conversationId: c._id })).status, 429);
    await services.mutate(c._id, alice, 'remove', {}, String(bob));
    removedDelivery = false;
    await ack(a, 'chat_message', text(c._id, 'After removal'));
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(removedDelivery, false);
    assert.equal((await ack(b, 'typing', { conversationId: c._id })).ok, false);
  } finally {
    [a, b, b2, stranger].forEach((s) => s.close());
  }
});
test('Redis outage is optional; Mongo path remains durable', async () => {
  const cache = await createCache({ redisUrl: 'redis://127.0.0.1:1', cacheEnabled: true });
  try {
    assert.equal(await cache.get('missing'), null);
    await cache.set('test', {});
    await cache.invalidate('test');
    assert.equal(await cache.buzz('c', 'u'), true);
    assert.equal(await cache.buzz('c', 'u'), false);
    const service = createServices({ db, client, cache });
    const c = await services.direct(carol, { targetUserId: String(dave) });
    assert.equal((await service.send(carol, text(c._id))).seq, 1);
    assert.equal((await service.history(c._id, carol)).messages.length, 1);
  } finally {
    await cache.close();
  }
});
test('commit-before-broadcast failure recovers from history and original retry ID', async () => {
  const c = await services.group(alice, { title: 'Crash recovery', userIds: [String(bob)] });
  const payload = text(c._id);
  const crashed = createServices({ db, client, cache: await createCache({}) });
  crashed.setDispatch(async () => {
    throw Error('Simulated crash after commit');
  });
  await assert.rejects(crashed.send(alice, payload), /Simulated crash/);
  const page = await services.history(c._id, bob, { afterSeq: 0 });
  assert.equal(page.messages.length, 1);
  const retry = await services.send(alice, payload);
  assert.equal(retry._id, page.messages[0]._id);
  assert.equal((await services.details(c._id, alice)).lastSeq, 1);
});
test('membership removal waits for dispatch; later sends omit removed recipients', async () => {
  const c = await services.group(alice, { title: 'Race', userIds: [String(bob)] });
  const isolated = createServices({ db, client, cache: await createCache({}) });
  let enter, release;
  const entered = new Promise((r) => {
      enter = r;
    }),
    held = new Promise((r) => {
      release = r;
    });
  const deliveries = [];
  isolated.setDispatch(async (id, event, payload, recipients) => {
    if (event !== 'chat_message') return;
    deliveries.push(recipients.map((m) => String(m.userId)));
    if (deliveries.length === 1) {
      enter();
      await held;
    }
  });
  const sending = isolated.send(alice, text(c._id));
  await entered;
  let removed = false;
  const removing = isolated.mutate(c._id, alice, 'remove', {}, String(bob)).then(() => {
    removed = true;
  });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(removed, false);
  release();
  await sending;
  await removing;
  await isolated.send(alice, text(c._id));
  assert.ok(deliveries[0].includes(String(bob)));
  assert.ok(!deliveries[1].includes(String(bob)));
});
