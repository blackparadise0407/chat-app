import { Server } from 'socket.io';
import { fail, oid, Limiter } from './core.js';
export function attachSockets(server, { auth, services, cfg }) {
  const allowed = new Set([cfg.origin, ...(!cfg.production ? [cfg.devOrigin] : [])]);
  const io = new Server(server, {
    maxHttpBufferSize: 20000,
    cors: { origin: [...allowed], methods: ['GET', 'POST'] },
    allowRequest: (req, cb) => cb(null, !req.headers.origin || allowed.has(req.headers.origin)),
  });
  const events = new Limiter(120, 60000),
    sends = new Limiter(30, 60000);
  const online = new Map();
  const userRoom = (id) => `user:${id}`;
  services.setDispatch(async (id, event, payload, recipients) => {
    for (const m of recipients) {
      if (event === 'conversation_removed')
        for (const socket of io.sockets.sockets.values())
          if (
            String(socket.data.identity.userId) === String(m.userId) &&
            socket.data.active === String(id)
          )
            socket.data.active = null;
      io.to(userRoom(m.userId)).emit(event, payload);
    }
  });
  async function presence(userId) {
    const relations = await services.db
      .collection('conversationMembers')
      .find({ userId, status: 'active' })
      .toArray();
    for (const m of relations)
      await services.lock.run(m.conversationId, async () => {
        try {
          await services.access(m.conversationId, userId);
          await services.publish(m.conversationId, 'presence_update', {
            userId: String(userId),
            online: (online.get(String(userId)) || 0) > 0,
          });
        } catch {}
      });
  }
  io.use(async (socket, next) => {
    try {
      socket.data.identity = await auth.authenticate(socket.handshake.auth?.token);
      next();
    } catch {
      next(new Error('Session expired or revoked'));
    }
  });
  io.on('connection', (socket) => {
    const identity = socket.data.identity,
      key = String(identity.userId);
    socket.join(userRoom(key));
    online.set(key, (online.get(key) || 0) + 1);
    presence(identity.userId).catch(() => {});
    const expiry = setTimeout(
      () => socket.disconnect(true),
      Math.max(1, identity.exp * 1000 - Date.now()),
    );
    expiry.unref();
    const revocation = setInterval(async () => {
      try {
        await auth.authenticate(identity.token);
      } catch {
        socket.disconnect(true);
      }
    }, 240000);
    revocation.unref();
    function on(event, fn) {
      socket.on(event, async (payload, ack) => {
        if (typeof ack !== 'function') return;
        try {
          if (identity.exp * 1000 <= Date.now()) fail(401, 'Session expired');
          events.take(key);
          ack({ ok: true, data: await fn(payload || {}) });
        } catch (e) {
          ack({
            ok: false,
            error: e.status ? e.message : 'Operation failed; retry safely',
            status: e.status || 503,
          });
        }
      });
    }
    on('conversation:subscribe', (p) =>
      services.lock.run(p.conversationId, async () => {
        const detail = await services.details(p.conversationId, identity.userId);
        socket.data.active = String(p.conversationId);
        return {
          ...detail,
          onlineUserIds: detail.members
            .filter((m) => online.get(String(m.userId)) > 0)
            .map((m) => String(m.userId)),
        };
      }),
    );
    on('conversation:unsubscribe', () => {
      socket.data.active = null;
      return { ok: true };
    });
    on('chat_message', (p) => {
      sends.take(key);
      return services.send(identity.userId, p);
    });
    on('messages_read', (p) => services.read(p.conversationId, identity.userId, p.seq));
    for (const event of ['typing', 'stop_typing', 'buzz'])
      on(event, (p) => services.transient(p.conversationId, identity.userId, event));
    socket.on('disconnect', () => {
      clearTimeout(expiry);
      clearInterval(revocation);
      const n = (online.get(key) || 1) - 1;
      if (n) online.set(key, n);
      else online.delete(key);
      presence(identity.userId).catch(() => {});
    });
  });
  return io;
}
