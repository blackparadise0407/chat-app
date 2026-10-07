import { ObjectId } from 'mongodb';
import { z } from 'zod';
import { transaction } from './db.js';
import {
  fail,
  oid,
  same,
  publicUser,
  json,
  parse,
  idSchema,
  titleSchema,
  messageSchema,
  profileSchema,
  KeyLock,
} from './core.js';
export function createServices({ db, client, cache }) {
  const users = db.collection('users'),
    convs = db.collection('conversations'),
    members = db.collection('conversationMembers'),
    messages = db.collection('messages'),
    attachments = db.collection('attachments');
  const lock = new KeyLock();
  let dispatch = async () => {};
  const opts = (session) => (session ? { session } : {});
  async function access(id, userId, session) {
    const c = await convs.findOne({ _id: oid(String(id)) }, opts(session));
    const m = await members.findOne(
      { conversationId: c?._id, userId, status: 'active' },
      opts(session),
    );
    if (!c || !m) fail(403, 'Conversation unavailable');
    return { c, m };
  }
  const membership = (id, userId, seq = 0) => ({
    _id: new ObjectId(),
    conversationId: id,
    userId,
    role: 'member',
    status: 'active',
    joinedAt: new Date(),
    joinedAfterSeq: seq,
    leftAt: null,
    lastReadSeq: seq,
    muted: false,
    archivedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  const baseConversation = (userId) => ({
    _id: new ObjectId(),
    createdBy: userId,
    ownerId: null,
    title: null,
    lastSeq: 0,
    lastMessageId: null,
    lastMessageAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  async function currentMembers(id, session) {
    return members
      .find({ conversationId: oid(String(id)), status: 'active' }, opts(session))
      .toArray();
  }
  async function publish(id, event, payload) {
    await dispatch(
      id,
      event,
      json({ conversationId: String(id), ...payload }),
      await currentMembers(id),
    );
  }
  async function details(id, userId) {
    const { c, m } = await access(id, userId);
    const ms = await currentMembers(id);
    const us = await users.find({ _id: { $in: ms.map((x) => x.userId) } }).toArray();
    return json({
      ...c,
      membership: m,
      members: ms.map((x) => ({ ...x, user: publicUser(us.find((u) => same(u._id, x.userId))) })),
    });
  }
  async function list(userId, query = {}) {
    const p = parse(
      z.object({
        page: z.coerce.number().int().min(0).max(10000).default(0),
        archived: z.enum(['true', 'false']).default('false'),
      }),
      query,
    );
    const matches = await members
      .find({ userId, status: 'active', archivedAt: p.archived === 'true' ? { $ne: null } : null })
      .toArray();
    const ids = matches.map((x) => x.conversationId);
    const cs = await convs
      .find({ _id: { $in: ids } })
      .sort({ lastMessageAt: -1, createdAt: -1, _id: -1 })
      .skip(p.page * 30)
      .limit(30)
      .toArray();
    const selected = cs.map((c) => c._id);
    const allMembers = await members
      .find({ conversationId: { $in: selected }, status: 'active' })
      .toArray();
    const us = await users.find({ _id: { $in: allMembers.map((m) => m.userId) } }).toArray();
    const last = await messages
      .find({ _id: { $in: cs.map((c) => c.lastMessageId).filter(Boolean) } })
      .toArray();
    const conditions = cs.map((c) => ({
      conversationId: c._id,
      seq: {
        $gt: Math.max(
          matches.find((m) => same(m.conversationId, c._id)).lastReadSeq,
          c.lastSeq - 1000,
        ),
      },
    }));
    const counts = conditions.length
      ? await messages
          .aggregate([
            { $match: { $or: conditions, senderId: { $ne: userId } } },
            { $group: { _id: '$conversationId', count: { $sum: 1 } } },
          ])
          .toArray()
      : [];
    return json(
      cs.map((c) => ({
        ...c,
        membership: matches.find((m) => same(m.conversationId, c._id)),
        members: allMembers
          .filter((m) => same(m.conversationId, c._id))
          .map((m) => ({ ...m, user: publicUser(us.find((u) => same(u._id, m.userId))) })),
        lastMessage: last.find((m) => same(m._id, c.lastMessageId)) || null,
        unread: counts.find((x) => same(x._id, c._id))?.count || 0,
      })),
    );
  }
  async function direct(userId, body) {
    const { targetUserId } = parse(z.object({ targetUserId: idSchema }), body);
    const other = oid(targetUserId);
    if (same(userId, other)) fail(400, 'Choose another user');
    if (!(await users.findOne({ _id: other }))) fail(404, 'User not found');
    const directKey = [String(userId), targetUserId].sort().join(':');
    return lock.run(`direct:${directKey}`, async () => {
      let c = await convs.findOne({ type: 'direct', directKey });
      if (!c) {
        try {
          c = await transaction(client, async (session) => {
            const c = { ...baseConversation(userId), type: 'direct', directKey };
            await convs.insertOne(c, { session });
            await members.insertMany([membership(c._id, userId), membership(c._id, other)], {
              session,
            });
            return c;
          });
        } catch (e) {
          if (e.code !== 11000) throw e;
          c = await convs.findOne({ type: 'direct', directKey });
          if (!c) throw e;
        }
      }
      await publish(c._id, 'conversation_updated', {});
      return details(c._id, userId);
    });
  }
  async function group(userId, body) {
    const { title, userIds } = parse(
      z.object({ title: titleSchema, userIds: z.array(idSchema).min(1).max(49) }),
      body,
    );
    const ids = [...new Set(userIds)].filter((x) => !same(x, userId)).map(oid);
    if (!ids.length || (await users.countDocuments({ _id: { $in: ids } })) !== ids.length)
      fail(400, 'Choose registered members');
    const c = await transaction(client, async (session) => {
      const c = { ...baseConversation(userId), type: 'group', title, ownerId: userId };
      await convs.insertOne(c, { session });
      await members.insertMany(
        [userId, ...ids].map((id) => membership(c._id, id)),
        { session },
      );
      return c;
    });
    await lock.run(c._id, () => publish(c._id, 'conversation_updated', {}));
    return details(c._id, userId);
  }
  async function mutate(id, userId, action, body = {}, targetId) {
    return lock.run(id, async () => {
      let removed = null;
      await transaction(client, async (session) => {
        const { c, m } = await access(id, userId, session);
        if (c.type !== 'group') fail(400, 'Direct chat membership cannot change');
        const owner = same(c.ownerId, userId),
          admin = owner || m.role === 'admin';
        const update = {};
        const now = new Date();
        if (action === 'rename') {
          if (!admin) fail(403, 'Admin required');
          update.title = parse(z.object({ title: titleSchema }), body).title;
        } else if (action === 'add') {
          if (!admin) fail(403, 'Admin required');
          const target = oid(parse(z.object({ userId: idSchema }), body).userId);
          if (!(await users.findOne({ _id: target }, { session }))) fail(404, 'User not found');
          const old = await members.findOne({ conversationId: c._id, userId: target }, { session });
          if (old?.status !== 'active') {
            if (
              (await members.countDocuments(
                { conversationId: c._id, status: 'active' },
                { session },
              )) >= 50
            )
              fail(400, 'Group limit is 50 members');
            const next = membership(c._id, target, c.lastSeq);
            if (old) {
              delete next._id;
              delete next.createdAt;
              await members.updateOne({ _id: old._id }, { $set: next }, { session });
            } else await members.insertOne(next, { session });
          }
        } else {
          const target = oid(targetId || parse(z.object({ userId: idSchema }), body).userId);
          const tm = await members.findOne(
            { conversationId: c._id, userId: target, status: 'active' },
            { session },
          );
          if (!tm) fail(404, 'Member unavailable');
          if (action === 'remove') {
            if (same(target, c.ownerId)) fail(409, 'Transfer ownership before leaving');
            if (!same(target, userId) && (!admin || (tm.role === 'admin' && !owner)))
              fail(403, 'Insufficient permission');
            await members.updateOne(
              { _id: tm._id },
              {
                $set: {
                  status: same(target, userId) ? 'left' : 'removed',
                  leftAt: now,
                  updatedAt: now,
                },
              },
              { session },
            );
            removed = String(target);
          } else if (action === 'role') {
            if (!owner || same(target, c.ownerId))
              fail(403, 'Owner required; owner role cannot change');
            const { role } = parse(z.object({ role: z.enum(['admin', 'member']) }), body);
            await members.updateOne(
              { _id: tm._id },
              { $set: { role, updatedAt: now } },
              { session },
            );
          } else if (action === 'transfer') {
            if (!owner || same(target, userId)) fail(403, 'Choose another member as owner');
            update.ownerId = target;
          } else fail(400, 'Unknown operation');
        }
        // Every mutation writes this record, serializing with message transactions.
        await convs.updateOne(
          { _id: c._id },
          { $set: { ...update, updatedAt: now }, $inc: { membershipVersion: 1 } },
          { session },
        );
      });
      if (removed)
        await dispatch(id, 'conversation_removed', { conversationId: String(id) }, [
          { userId: oid(removed) },
        ]);
      await publish(id, 'conversation_updated', {});
      return { ok: true };
    });
  }
  async function preferences(id, userId, body) {
    const p = parse(
      z.object({ muted: z.boolean().optional(), archived: z.boolean().optional() }),
      body,
    );
    return lock.run(id, async () => {
      const { m } = await access(id, userId);
      await members.updateOne(
        { _id: m._id },
        {
          $set: {
            ...(p.muted !== undefined ? { muted: p.muted } : {}),
            ...(p.archived !== undefined ? { archivedAt: p.archived ? new Date() : null } : {}),
            updatedAt: new Date(),
          },
        },
      );
      await dispatch(id, 'conversation_updated', { conversationId: String(id) }, [{ userId }]);
      return { ok: true };
    });
  }
  async function history(id, userId, query = {}) {
    const p = parse(
      z
        .object({
          beforeSeq: z.coerce.number().int().positive().optional(),
          afterSeq: z.coerce.number().int().min(0).optional(),
          highWaterSeq: z.coerce.number().int().min(0).optional(),
          limit: z.coerce.number().int().min(1).max(100).default(50),
          authoritative: z.enum(['true', 'false']).optional(),
        })
        .refine((x) => x.beforeSeq === undefined || x.afterSeq === undefined, 'Choose one cursor'),
      query,
    );
    const { c } = await access(id, userId);
    const highWaterSeq = Math.min(p.highWaterSeq ?? c.lastSeq, c.lastSeq);
    const retainedFromSeq = Math.max(1, c.lastSeq - 999);
    const latest =
      p.beforeSeq === undefined &&
      p.afterSeq === undefined &&
      p.highWaterSeq === undefined &&
      p.limit === 50 &&
      p.authoritative !== 'true';
    if (latest) {
      const hit = await cache.get(id);
      if (hit) return hit;
    }
    const seq = { $gte: retainedFromSeq, $lte: highWaterSeq };
    if (p.beforeSeq !== undefined) seq.$lt = p.beforeSeq;
    if (p.afterSeq !== undefined) seq.$gt = p.afterSeq;
    const data = await messages
      .find({ conversationId: c._id, seq })
      .sort({ seq: p.afterSeq !== undefined ? 1 : -1 })
      .limit(p.limit + 1)
      .toArray();
    const hasMore = data.length > p.limit;
    data.splice(p.limit);
    if (p.afterSeq === undefined) data.reverse();
    const result = json({
      messages: data,
      highWaterSeq,
      retainedFromSeq,
      expired: p.afterSeq !== undefined && p.afterSeq < retainedFromSeq - 1,
      hasMore,
    });
    if (latest) await cache.set(id, result);
    return result;
  }
  async function send(userId, input) {
    const p = parse(messageSchema, input);
    if (p.type === 'text' && !p.content?.trim()) fail(400, 'Message is empty');
    if (p.type === 'image' && !p.attachmentId) fail(400, 'Attachment required');
    return lock.run(p.conversationId, async () => {
      const result = await transaction(client, async (session) => {
        const { c } = await access(p.conversationId, userId, session);
        const existing = await messages.findOne(
          { conversationId: c._id, senderId: userId, clientMessageId: p.clientMessageId },
          { session },
        );
        if (existing) {
          if (
            existing.type !== p.type ||
            (p.type === 'text'
              ? existing.content !== p.content
              : !same(existing.attachmentId, p.attachmentId))
          )
            fail(409, 'Retry ID was reused with different content');
          return { message: existing, duplicate: true };
        }
        let attachment;
        if (p.type === 'image') {
          attachment = await attachments.findOne(
            {
              _id: oid(p.attachmentId),
              conversationId: c._id,
              ownerId: userId,
              messageId: null,
              ready: true,
            },
            { session },
          );
          if (!attachment) fail(403, 'Attachment unavailable');
        }
        const seq = c.lastSeq + 1,
          now = new Date(),
          message = {
            _id: new ObjectId(),
            conversationId: c._id,
            seq,
            senderId: userId,
            clientMessageId: p.clientMessageId,
            type: p.type,
            content: p.type === 'text' ? p.content : `/api/media/${attachment._id}`,
            imageKey: attachment?.key || null,
            attachmentId: attachment?._id || null,
            createdAt: now,
          };
        await convs.updateOne(
          { _id: c._id },
          {
            $set: { lastSeq: seq, lastMessageId: message._id, lastMessageAt: now, updatedAt: now },
          },
          { session },
        );
        await messages.insertOne(message, { session });
        if (attachment)
          await attachments.updateOne(
            { _id: attachment._id },
            { $set: { messageId: message._id } },
            { session },
          );
        await members.updateMany(
          { conversationId: c._id, status: 'active' },
          { $set: { archivedAt: null } },
          { session },
        );
        return { message, duplicate: false };
      });
      if (!result.duplicate) {
        await cache.invalidate(p.conversationId);
        await publish(p.conversationId, 'chat_message', { message: result.message });
      }
      return json(result.message);
    });
  }
  async function read(id, userId, seq) {
    seq = parse(z.number().int().positive(), seq);
    return lock.run(id, async () => {
      await transaction(client, async (session) => {
        const { c, m } = await access(id, userId, session);
        if (
          seq > c.lastSeq ||
          !(await messages.findOne({ conversationId: c._id, seq }, { session }))
        )
          fail(400, 'Read position must reference a retained message');
        await members.updateOne(
          { _id: m._id },
          { $max: { lastReadSeq: seq }, $set: { updatedAt: new Date() } },
          { session },
        );
        await convs.updateOne({ _id: c._id }, { $inc: { readVersion: 1 } }, { session });
      });
      const { m } = await access(id, userId);
      await publish(id, 'read_receipt_update', { userId: String(userId), seq: m.lastReadSeq });
      return { seq: m.lastReadSeq };
    });
  }
  async function transient(id, userId, event) {
    return lock.run(id, async () => {
      await access(id, userId);
      if (event === 'buzz' && !(await cache.buzz(id, userId)))
        fail(429, 'Buzz available every 45 seconds');
      await publish(id, event, { userId: String(userId), expiresAt: Date.now() + 4000 });
      return { ok: true };
    });
  }
  async function cleanup(storage) {
    for await (const c of convs.find({}, { projection: { lastSeq: 1 } }))
      await lock.run(c._id, async () => {
        const result = await messages.deleteMany({
          conversationId: c._id,
          seq: { $lt: c.lastSeq - 999 },
        });
        if (result.deletedCount) await cache.invalidate(c._id);
      });
    // Message attachment references are protected by the same conversation lock.
    for await (const a of attachments.find({ createdAt: { $lt: new Date(Date.now() - 86400000) } }))
      await lock.run(a.conversationId, async () => {
        if (await messages.findOne({ attachmentId: a._id })) return;
        await storage.delete(a.key);
        await attachments.deleteOne({ _id: a._id });
      });
  }
  return {
    db,
    lock,
    access,
    currentMembers,
    publish,
    setDispatch(fn) {
      dispatch = fn;
    },
    details,
    list,
    direct,
    group,
    mutate,
    preferences,
    history,
    send,
    read,
    transient,
    cleanup,
    async me(userId) {
      return publicUser(await users.findOne({ _id: userId }));
    },
    async profile(userId, body) {
      const p = parse(profileSchema, body);
      try {
        await users.updateOne({ _id: userId }, { $set: { ...p, updatedAt: new Date() } });
      } catch (e) {
        if (e.code === 11000) fail(409, 'Handle already taken');
        throw e;
      }
      const shared = await members.find({ userId, status: 'active' }).toArray();
      for (const m of shared)
        await lock.run(m.conversationId, () =>
          publish(m.conversationId, 'conversation_updated', {}),
        );
      return publicUser(await users.findOne({ _id: userId }));
    },
    async lookup(query) {
      const q = parse(
        z
          .object({
            id: idSchema.optional(),
            handle: z
              .string()
              .regex(/^[a-z0-9_]{3,24}$/)
              .optional(),
          })
          .refine((x) => Boolean(x.id) !== Boolean(x.handle), 'Supply exact ID or handle'),
        query,
      );
      const user = await users.findOne(q.id ? { _id: oid(q.id) } : { handle: q.handle });
      return user ? publicUser(user) : null;
    },
  };
}
