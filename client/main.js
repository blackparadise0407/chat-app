import { initializeApp } from 'firebase/app';
import {
  getAuth,
  onIdTokenChanged,
  GoogleAuthProvider,
  signInWithPopup,
  signOut,
} from 'firebase/auth';
import { io } from 'socket.io-client';
import './style.css';
const root = document.querySelector('#app'),
  toastEl = document.querySelector('#toast');
const escape = (s) =>
  String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
const state = {
  user: null,
  me: null,
  conversations: [],
  cache: new Map(),
  pending: new Map(),
  socket: null,
  active: null,
  details: null,
  online: new Set(),
  typing: new Map(),
  version: 0,
  epoch: 0,
  repairing: new Set(),
  connection: 'Connecting',
  objectUrls: new Map(),
  loadingImages: new Set(),
  history: null,
  abort: null,
  page: 0,
  archived: false,
};
let firebaseAuth,
  tokenTimer,
  refreshListTimer,
  audioContext,
  readTimer,
  logoutInProgress = false;
const prefs = () => JSON.parse(localStorage.getItem('relay.preferences') || '{}');
const themes = ['dark', 'light', 'glass', 'midnight', 'forest', 'ocean', 'rose', 'sunset'];
const savedTheme = localStorage.getItem('relay.theme');
document.documentElement.dataset.theme = themes.includes(savedTheme) ? savedTheme : 'dark';
const title = (c) =>
  c.type === 'group'
    ? c.title
    : c.members.find((m) => m.userId !== state.me.id)?.user.displayName || 'Direct chat';
const initials = (name) =>
  String(name || '?')
    .split(' ')
    .map((x) => x[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();
function avatar(name, avatarUrl) {
  let src = '';
  try {
    const url = new URL(avatarUrl);
    if (url.protocol === 'https:') src = url.href;
  } catch {}
  return `<span class="avatar"><span class="avatar-initials" aria-hidden="true">${escape(initials(name))}</span>${src ? `<img class="avatar-photo" src="${escape(src)}" alt="${escape(name || 'User')} avatar" loading="lazy" decoding="async" referrerpolicy="no-referrer">` : ''}</span>`;
}
const conversationAvatar = (c) => {
  const user = c.type === 'direct' ? c.members.find((m) => m.userId !== state.me.id)?.user : null;
  return avatar(title(c), user?.avatarUrl);
};
// Image error events do not bubble; capture them to keep initials visible on failure.
document.addEventListener(
  'error',
  (event) => {
    if (event.target.matches?.('.avatar-photo')) event.target.remove();
  },
  true,
);
function toast(message) {
  toastEl.textContent = message;
  toastEl.classList.add('show');
  setTimeout(() => toastEl.classList.remove('show'), 4000);
}
function go(path, replace = false) {
  if (!path.startsWith('/') || path.startsWith('//')) path = '/conversations';
  history[replace ? 'replaceState' : 'pushState']({}, '', path);
  render().catch(showError);
}
function showError(e) {
  if (e.name !== 'AbortError') toast(e.message || 'Something went wrong');
}
async function api(path, options = {}) {
  const user = state.user;
  if (!user) throw new Error('Sign in required');
  const token = await user.getIdToken();
  const response = await fetch(`/api${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(options.body && !(options.body instanceof FormData)
        ? { 'Content-Type': 'application/json' }
        : {}),
      ...options.headers,
    },
  });
  if (user !== state.user) throw new DOMException('Account changed', 'AbortError');
  if (!response.ok) {
    let error;
    try {
      error = (await response.json()).error;
    } catch {}
    const e = new Error(error || 'Request failed');
    e.status = response.status;
    throw e;
  }
  return options.blob ? response.blob() : response.json();
}
const post = (path, body, method = 'POST') => api(path, { method, body: JSON.stringify(body) });
function emit(event, payload) {
  return new Promise((resolve, reject) => {
    if (!state.socket?.connected)
      return reject(new Error('Disconnected. Your message is kept for retry.'));
    state.socket.timeout(10000).emit(event, payload, (error, result) => {
      if (error) reject(new Error('No acknowledgement. Retry with the same message ID.'));
      else if (!result?.ok)
        reject(
          Object.assign(new Error(result?.error || 'Request failed'), { status: result?.status }),
        );
      else resolve(result.data);
    });
  });
}
function clearPrivate() {
  state.epoch++;
  state.repairing.clear();
  state.version++;
  state.abort?.abort();
  state.socket?.removeAllListeners();
  state.socket?.disconnect();
  state.socket = null;
  clearTimeout(refreshListTimer);
  clearTimeout(readTimer);
  clearInterval(tokenTimer);
  for (const url of state.objectUrls.values()) URL.revokeObjectURL(url);
  state.objectUrls.clear();
  state.loadingImages.clear();
  state.me = null;
  state.user = null;
  state.conversations = [];
  state.cache.clear();
  state.pending.clear();
  state.typing.clear();
  state.online.clear();
  state.active = null;
  state.details = null;
  document.title = 'Relay · Private chat';
  const box = document.querySelector('#lightbox');
  box.close();
  box.querySelector('img').removeAttribute('src');
}
const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('relay.auth') : null;
channel?.addEventListener('message', (e) => {
  if (e.data === 'logout') {
    clearPrivate();
    go('/login', true);
    signOut(firebaseAuth).catch(showError);
  }
});
async function logout() {
  logoutInProgress = true;
  clearPrivate();
  channel?.postMessage('logout');
  await signOut(firebaseAuth);
  logoutInProgress = false;
  go('/login', true);
}
function notify(message) {
  if (prefs().sound !== false) {
    try {
      audioContext ||= new AudioContext();
      const oscillator = audioContext.createOscillator(),
        gain = audioContext.createGain();
      oscillator.connect(gain).connect(audioContext.destination);
      oscillator.frequency.value = 660;
      gain.gain.setValueAtTime(0.08, audioContext.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, audioContext.currentTime + 0.18);
      oscillator.start();
      oscillator.stop(audioContext.currentTime + 0.18);
    } catch {}
  }
  if (
    document.hidden &&
    prefs().notifications &&
    'Notification' in window &&
    Notification.permission === 'granted'
  ) {
    const n = new Notification('New message in Relay', { body: message });
    n.onclick = () => {
      window.focus();
      n.close();
    };
  }
}
async function refreshList() {
  if (!state.user) return;
  const version = state.version;
  const items = await api(`/conversations?page=${state.page}&archived=${state.archived}`);
  if (version !== state.version) return;
  state.conversations = items;
  sidebar();
  const unread = items.reduce((n, c) => n + c.unread, 0);
  document.title = unread ? `(${unread}) Relay` : 'Relay · Private chat';
  updateFavicon(unread);
}
function updateFavicon(unread) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="18" fill="#7c6af5"/><path d="M16 18h32v23H29l-10 8v-8h-3z" fill="white"/>${unread ? '<circle cx="51" cy="13" r="11" fill="#f97373"/>' : ''}</svg>`;
  document.querySelector('link[rel="icon"]').href = `data:image/svg+xml,${encodeURIComponent(svg)}`;
}
function scheduleList() {
  clearTimeout(refreshListTimer);
  refreshListTimer = setTimeout(() => refreshList().catch(showError), 150);
}
function merge(id, incoming) {
  const items = state.cache.get(id) || [];
  const map = new Map(items.map((m) => [m._id, m]));
  for (const m of incoming) {
    map.set(m._id, m);
    for (const [key, p] of state.pending)
      if (
        p.conversationId === id &&
        p.clientMessageId === m.clientMessageId &&
        m.senderId === state.me?.id
      )
        state.pending.delete(key);
  }
  const result = [...map.values()].sort((a, b) => a.seq - b.seq).slice(-1000);
  state.cache.delete(id);
  state.cache.set(id, result);
  if (result.some((m, i) => i > 0 && m.seq !== result[i - 1].seq + 1)) repair(id);
  while (state.cache.size > 10) {
    const key = state.cache.keys().next().value;
    if (key === state.active) {
      const value = state.cache.get(key);
      state.cache.delete(key);
      state.cache.set(key, value);
    } else state.cache.delete(key);
  }
}
function contiguousSeq(id) {
  const messages = state.cache.get(id) || [];
  let seq = messages[0]?.seq || 0;
  for (const message of messages.slice(1)) {
    if (message.seq !== seq + 1) break;
    seq = message.seq;
  }
  return seq;
}
function repair(id) {
  if (state.repairing.has(id)) return;
  const epoch = state.epoch;
  state.repairing.add(id);
  catchup(id, contiguousSeq(id))
    .then(() => {
      if (epoch === state.epoch && state.active === id) timeline(false);
    })
    .catch(showError)
    .finally(() => {
      if (epoch === state.epoch) state.repairing.delete(id);
    });
}
async function catchup(id, fromSeq, signal) {
  let highWater,
    cursor = fromSeq;
  for (;;) {
    const page = await api(
      `/conversations/${id}/messages?afterSeq=${cursor}${highWater === undefined ? '' : `&highWaterSeq=${highWater}`}`,
      { signal },
    );
    highWater ??= page.highWaterSeq;
    if (page.expired) {
      state.cache.delete(id);
      toast('Some older messages have expired.');
    }
    merge(id, page.messages);
    if (!page.hasMore) break;
    cursor = page.messages.at(-1).seq;
  }
}
async function connect(user) {
  const token = await user.getIdToken();
  if (state.user !== user) return;
  state.socket?.removeAllListeners();
  state.socket?.disconnect();
  const socket = io({ autoConnect: false, auth: { token } });
  state.socket = socket;
  socket.on('chat_message', ({ conversationId: id, message }) => {
    if (state.cache.has(id) || state.active === id) merge(id, [message]);
    else if (message.senderId === state.me?.id)
      for (const [key, p] of state.pending)
        if (p.clientMessageId === message.clientMessageId) state.pending.delete(key);
    if (state.active === id) timeline(false);
    if (
      message.senderId !== state.me.id &&
      !state.conversations.find((c) => c._id === id)?.membership.muted
    )
      notify('You have a new message');
    scheduleList();
  });
  socket.on('conversation_updated', ({ conversationId }) => {
    scheduleList();
    if (state.active === conversationId) updateDetails(conversationId).catch(showError);
  });
  socket.on('conversation_removed', ({ conversationId: id }) => {
    state.cache.delete(id);
    for (const [key, p] of state.pending) if (p.conversationId === id) state.pending.delete(key);
    for (const [key, url] of state.objectUrls)
      if (key.startsWith(`${id}:`)) {
        URL.revokeObjectURL(url);
        state.objectUrls.delete(key);
      }
    document.querySelector('#lightbox').close();
    if (state.active === id) {
      toast('You no longer have access to this conversation');
      go('/conversations', true);
    }
    scheduleList();
  });
  socket.on('read_receipt_update', ({ conversationId, userId, seq }) => {
    for (const c of [state.details, ...state.conversations])
      if (c?._id === conversationId) {
        const m = c.members.find((m) => m.userId === userId);
        if (m) m.lastReadSeq = Math.max(m.lastReadSeq, seq);
      }
    if (state.active === conversationId) timeline(false);
    scheduleList();
  });
  socket.on('presence_update', ({ userId, online }) => {
    online ? state.online.add(userId) : state.online.delete(userId);
    sidebar();
    chatHeader();
  });
  for (const event of ['typing', 'stop_typing'])
    socket.on(event, ({ conversationId, userId, expiresAt }) => {
      if (userId === state.me.id) return;
      const key = `${conversationId}:${userId}`;
      if (event === 'typing') state.typing.set(key, expiresAt);
      else state.typing.delete(key);
      typingView();
    });
  socket.on('buzz', ({ conversationId, userId }) => {
    if (
      userId === state.me.id ||
      state.conversations.find((c) => c._id === conversationId)?.membership.muted
    )
      return;
    notify('Someone sent you a buzz');
    root.classList.add('buzz');
    setTimeout(() => root.classList.remove('buzz'), 600);
    toast('Buzz!');
  });
  socket.on('connect', async () => {
    state.connection = 'Online';
    connectionView();
    try {
      await refreshList();
      for (const [id, messages] of [...state.cache]) {
        try {
          await catchup(id, contiguousSeq(id));
        } catch (e) {
          if (e.status === 403) state.cache.delete(id);
          else throw e;
        }
      }
      if (state.active) {
        const selected = state.active;
        const d = await emit('conversation:subscribe', { conversationId: selected });
        if (selected === state.active) {
          state.details = d;
          timeline(false);
        }
      }
      for (const p of [...state.pending.values()]) retry(p);
    } catch (e) {
      showError(e);
    }
  });
  socket.on('disconnect', (reason) => {
    state.connection = 'Reconnecting';
    connectionView();
    if (reason === 'io server disconnect' && state.user === user)
      user
        .getIdToken(true)
        .then((t) => {
          socket.auth = { token: t };
          socket.connect();
        })
        .catch(showError);
  });
  socket.on('connect_error', (e) => {
    state.connection = 'Connection failed';
    connectionView();
    if (/Session/.test(e.message))
      user
        .getIdToken(true)
        .then((t) => {
          socket.auth = { token: t };
          setTimeout(() => socket.connect(), 1000);
        })
        .catch(showError);
  });
  socket.io.on('reconnect_attempt', async () => {
    try {
      socket.auth = { token: await user.getIdToken() };
    } catch {}
  });
  socket.connect();
  clearInterval(tokenTimer);
  tokenTimer = setInterval(async () => {
    if (state.user !== user) return;
    try {
      socket.auth = { token: await user.getIdToken(true) };
      socket.disconnect().connect();
    } catch (e) {
      showError(e);
    }
  }, 50 * 60000);
}
function connectionView() {
  const el = document.querySelector('#connection');
  if (el) el.textContent = state.connection;
}
function shell() {
  root.innerHTML = `<div class="app-shell"><aside><a class="brand" data-link href="/conversations"><span class="brand-icon">R</span>Relay<span class="tag">PRIVATE</span></a><div class="aside-title">YOUR CONVERSATIONS <button id="archive-view" class="text-button">${state.archived ? 'Active' : 'Archived'}</button></div><div class="new-actions"><a data-link href="/conversations/new">＋ New chat</a><a data-link href="/groups/new">New group</a></div><nav id="conversations"></nav><div class="pagination"><button id="prev-page">←</button><span id="page-label"></span><button id="next-page">→</button></div><div class="account">${avatar(state.me.displayName, state.me.avatarUrl)}<a data-link href="/settings/profile"><strong>${escape(state.me.displayName)}</strong><small>@${escape(state.me.handle)}</small></a><a data-link href="/settings/preferences" aria-label="Preferences">⚙</a></div></aside><main id="screen"></main></div>`;
  sidebar();
  document.querySelector('#archive-view').onclick = () => {
    state.archived = !state.archived;
    state.page = 0;
    refreshList()
      .then(() => {
        document.querySelector('#archive-view').textContent = state.archived
          ? 'Active'
          : 'Archived';
      })
      .catch(showError);
  };
  document.querySelector('#prev-page').onclick = () => {
    state.page = Math.max(0, state.page - 1);
    refreshList().catch(showError);
  };
  document.querySelector('#next-page').onclick = () => {
    if (state.conversations.length === 30) {
      state.page++;
      refreshList().catch(showError);
    }
  };
}
function sidebar() {
  const nav = document.querySelector('#conversations');
  if (!nav || !state.me) return;
  nav.innerHTML =
    state.conversations
      .map(
        (c) =>
          `<a class="conversation ${state.active === c._id ? 'selected' : ''}" data-link href="/conversations/${c._id}">${conversationAvatar(c)}<div><strong>${escape(title(c))}</strong><small>${c.membership.muted ? 'Muted · ' : ''}${escape(c.lastMessage?.type === 'image' ? 'Photo' : c.lastMessage?.content || 'Start a conversation')}</small></div><span>${c.unread ? `<b class="badge">${c.unread}</b>` : ''}<small>${c.lastMessageAt ? new Date(c.lastMessageAt).toLocaleDateString([], { month: 'short', day: 'numeric' }) : ''}</small></a>`,
      )
      .join('') || '<p class="muted empty-list">No conversations yet</p>';
  const p = document.querySelector('#page-label');
  if (p) p.textContent = `Page ${state.page + 1}`;
}
async function updateDetails(id) {
  const detail = await api(`/conversations/${id}`);
  if (state.active !== id) return;
  state.details = detail;
  chatHeader();
  timeline(false);
}
function chatHeader() {
  const el = document.querySelector('#chat-header');
  if (!el || !state.details) return;
  const c = state.details;
  el.innerHTML = `<div class="header-person">${conversationAvatar(c)}<div><h2>${escape(title(c))}</h2><small>${c.type === 'group' ? `${c.members.length} members` : state.online.has(c.members.find((m) => m.userId !== state.me.id)?.userId) ? 'Online' : 'Private conversation'}</small></div></div><div class="header-actions"><span id="connection">${state.connection}</span><button id="buzz-button" title="Buzz · 45-second cooldown">⚡ Buzz</button><a data-link href="/conversations/${c._id}/details" class="button">Details</a></div>`;
  document.querySelector('#buzz-button').onclick = () =>
    emit('buzz', { conversationId: c._id }).catch(showError);
}
function receipt(m) {
  if (m.senderId !== state.me.id || !state.details) return '';
  const readers = state.details.members.filter(
    (x) => x.userId !== m.senderId && x.lastReadSeq >= m.seq && m.seq > x.joinedAfterSeq,
  );
  return readers.length
    ? `<small class="receipt" title="${escape(readers.map((x) => x.user.displayName).join(', '))}">✓✓ ${state.details.type === 'direct' ? 'Read' : `Read by ${readers.length}`}</small>`
    : '<small class="receipt">✓ Sent</small>';
}
function timeline(forceBottom = false) {
  const el = document.querySelector('#timeline');
  if (!el || !state.active) return;
  const distance = el.scrollHeight - el.scrollTop - el.clientHeight,
    oldTop = el.scrollTop;
  const items = state.cache.get(state.active) || [],
    pending = [...state.pending.values()].filter((p) => p.conversationId === state.active);
  const c = state.details;
  el.innerHTML = `<button id="older" class="older">Load older messages</button>${state.history?.expired ? '<p class="expiry">Older messages have expired</p>' : ''}${items
    .map((m, i) => {
      const mine = m.senderId === state.me.id,
        next = items[i + 1],
        previous = items[i - 1],
        grouped =
          previous &&
          previous.senderId === m.senderId &&
          new Date(m.createdAt) - new Date(previous.createdAt) < 120000,
        last =
          !next ||
          next.senderId !== m.senderId ||
          new Date(next.createdAt) - new Date(m.createdAt) >= 120000,
        sender = c?.members.find((x) => x.userId === m.senderId)?.user;
      const senderName = sender?.displayName || 'Former member';
      return `<div class="message ${mine ? 'mine' : ''} ${grouped ? 'grouped' : ''}">${!mine && !grouped ? `<span class="sender">${avatar(senderName, sender?.avatarUrl)}<small>${escape(senderName)}</small></span>` : ''}<div class="bubble">${m.type === 'image' ? `<img class="shared-image" data-image="${m.attachmentId}" alt="Shared photo" loading="lazy">` : escape(m.content).replace(/(https?:\/\/[^\s&<>]+)/g, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>')}<time>${new Date(m.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time></div>${last ? receipt(m) : ''}</div>`;
    })
    .join(
      '',
    )}${pending.map((p) => `<div class="message mine pending"><div class="bubble">${escape(p.type === 'image' ? 'Sending photo…' : p.content)}</div><button class="retry text-button" data-retry="${p.clientMessageId}">${p.failed ? 'Failed · Retry' : 'Sending…'}</button></div>`).join('')}`;
  document.querySelector('#older').onclick = loadOlder;
  el.querySelectorAll('[data-retry]').forEach(
    (b) => (b.onclick = () => retry(state.pending.get(b.dataset.retry))),
  );
  el.querySelectorAll('[data-image]').forEach((img) => loadImage(img).catch(showError));
  if (forceBottom || distance < 100) el.scrollTop = el.scrollHeight;
  else {
    el.scrollTop = oldTop;
    const indicator = document.querySelector('#new-messages');
    if (indicator) indicator.hidden = false;
  }
  scheduleRead();
}
async function loadImage(img) {
  const id = state.active,
    version = state.version,
    key = `${id}:${img.dataset.image}`;
  let url = state.objectUrls.get(key);
  if (!url) {
    const blob = await api(`/media/${img.dataset.image}`, { blob: true });
    if (version !== state.version || !img.isConnected) return;
    url = URL.createObjectURL(blob);
    state.objectUrls.set(key, url);
    while (state.objectUrls.size > 200) {
      const old = state.objectUrls.keys().next().value;
      URL.revokeObjectURL(state.objectUrls.get(old));
      state.objectUrls.delete(old);
    }
  }
  img.src = url;
  img.onclick = () => {
    const box = document.querySelector('#lightbox');
    box.querySelector('img').src = url;
    box.showModal();
  };
}
async function loadOlder() {
  const id = state.active,
    el = document.querySelector('#timeline'),
    first = state.cache.get(id)?.[0]?.seq;
  if (!first) return;
  const page = await api(`/conversations/${id}/messages?beforeSeq=${first}`, {
    signal: state.abort.signal,
  });
  if (state.active !== id) return;
  if (!page.messages.length) {
    toast('No earlier retained messages');
    return;
  }
  const before = el.scrollHeight,
    top = el.scrollTop;
  merge(id, page.messages);
  timeline(false);
  el.scrollTop = el.scrollHeight - before + top;
}
function scheduleRead() {
  clearTimeout(readTimer);
  readTimer = setTimeout(() => {
    const el = document.querySelector('#timeline'),
      id = state.active;
    if (
      !el ||
      document.hidden ||
      !document.hasFocus() ||
      el.scrollHeight - el.scrollTop - el.clientHeight > 40 ||
      !state.socket?.connected
    )
      return;
    const last = state.cache.get(id)?.at(-1);
    if (
      last &&
      contiguousSeq(id) === last.seq &&
      last.seq > (state.details?.members.find((m) => m.userId === state.me.id)?.lastReadSeq || 0)
    )
      emit('messages_read', { conversationId: id, seq: last.seq }).catch(showError);
  }, 600);
}
async function retry(p) {
  if (!p || p.sending) return;
  p.sending = true;
  p.failed = false;
  const version = state.epoch;
  try {
    const message = await emit('chat_message', {
      conversationId: p.conversationId,
      clientMessageId: p.clientMessageId,
      type: p.type,
      ...(p.content !== undefined ? { content: p.content } : {}),
      ...(p.attachmentId ? { attachmentId: p.attachmentId } : {}),
    });
    if (version !== state.epoch) return;
    merge(p.conversationId, [message]);
    scheduleList();
  } catch (e) {
    if (version === state.epoch) {
      p.failed = true;
      showError(e);
    }
  } finally {
    p.sending = false;
    if (version === state.epoch && state.active === p.conversationId) timeline(true);
  }
}
function send(type, content, attachmentId) {
  if (state.pending.size >= 100) return toast('Retry your pending messages before sending more');
  const p = {
    conversationId: state.active,
    clientMessageId: crypto.randomUUID(),
    type,
    content,
    attachmentId,
  };
  state.pending.set(p.clientMessageId, p);
  timeline(true);
  retry(p);
}
async function upload(file) {
  const id = state.active,
    version = state.version;
  if (!file?.type.startsWith('image/')) return toast('Choose an image');
  const data = new FormData();
  let image = file;
  if (file.size > 2 * 1024 * 1024) {
    try {
      const bitmap = await createImageBitmap(file),
        canvas = document.createElement('canvas');
      const scale = Math.min(1, 2400 / Math.max(bitmap.width, bitmap.height));
      canvas.width = bitmap.width * scale;
      canvas.height = bitmap.height * scale;
      canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      image = await new Promise((resolve) => canvas.toBlob(resolve, 'image/webp', 0.85));
      bitmap.close();
    } catch {}
  }
  if (!image || image.size > 5 * 1024 * 1024) return toast('Image must be under 5 MiB');
  data.append('image', image);
  toast('Uploading photo…');
  const result = await api(`/conversations/${id}/uploads`, { method: 'POST', body: data });
  if (version !== state.version || state.active !== id)
    return toast('Upload finished. Return to the conversation to upload and send.');
  send('image', undefined, result.attachmentId);
}
function typingView() {
  const el = document.querySelector('#typing');
  if (!el || !state.details) return;
  const now = Date.now();
  for (const [key, expiry] of state.typing) if (expiry <= now) state.typing.delete(key);
  const names = state.details.members
    .filter((m) => state.typing.has(`${state.active}:${m.userId}`))
    .map((m) => m.user.displayName);
  el.textContent = names.length
    ? `${names.join(', ')} ${names.length === 1 ? 'is' : 'are'} typing…`
    : '';
}
setInterval(typingView, 1000);
async function chat(id, version) {
  state.active = id;
  sidebar();
  const screen = document.querySelector('#screen');
  screen.innerHTML = '<div class="loading">Loading conversation…</div>';
  let detail;
  try {
    detail = await api(`/conversations/${id}`, { signal: state.abort.signal });
  } catch (e) {
    if (e.status === 403) {
      state.cache.delete(id);
      go('/conversations', true);
    }
    throw e;
  }
  if (version !== state.version) return;
  state.details = detail;
  if (state.socket?.connected) {
    const snapshot = await emit('conversation:subscribe', { conversationId: id });
    if (version !== state.version) return;
    state.online = new Set(snapshot.onlineUserIds);
  }
  const page = await api(`/conversations/${id}/messages?authoritative=true`, {
    signal: state.abort.signal,
  });
  if (version !== state.version) return;
  state.history = page;
  merge(id, page.messages);
  screen.innerHTML = `<section class="chat"><header id="chat-header"></header><div id="timeline" class="timeline" role="log" aria-label="Messages"></div><button id="new-messages" class="new-indicator" hidden>New messages ↓</button><div id="typing" class="typing"></div><form id="composer" class="composer"><label class="attach" title="Send photo">＋<input id="image-input" type="file" accept="image/jpeg,image/png,image/webp" hidden></label><textarea id="draft" maxlength="4000" rows="1" placeholder="Write a message…" aria-label="Message"></textarea><button type="submit">Send ↗</button></form><div class="chat-note">Only members of this conversation can access its messages.</div></section>`;
  chatHeader();
  timeline(true);
  const el = document.querySelector('#timeline');
  el.onscroll = scheduleRead;
  document.querySelector('#new-messages').onclick = (e) => {
    el.scrollTop = el.scrollHeight;
    e.target.hidden = true;
    scheduleRead();
  };
  const draft = document.querySelector('#draft');
  let lastTyped = 0;
  draft.oninput = () => {
    if (Date.now() - lastTyped > 2000) {
      lastTyped = Date.now();
      emit('typing', { conversationId: id }).catch(() => {});
    }
  };
  draft.onkeydown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      document.querySelector('#composer').requestSubmit();
    }
  };
  draft.onpaste = (e) => {
    const f = [...e.clipboardData.files].find((f) => f.type.startsWith('image/'));
    if (f) {
      e.preventDefault();
      upload(f).catch(showError);
    }
  };
  document.querySelector('#composer').onsubmit = (e) => {
    e.preventDefault();
    if (!draft.value.trim()) return;
    send('text', draft.value);
    draft.value = '';
    emit('stop_typing', { conversationId: id }).catch(() => {});
  };
  document.querySelector('#image-input').onchange = (e) => {
    if (e.target.files[0]) upload(e.target.files[0]).catch(showError);
    e.target.value = '';
  };
}
function card(heading, subtitle, content) {
  document.querySelector('#screen').innerHTML =
    `<section class="page"><div class="eyebrow">RELAY / YOUR SPACE</div><h1>${heading}</h1><p class="muted">${subtitle}</p>${content}</section>`;
}
function newConversation(group = false) {
  const chosen = new Map();
  card(
    group ? 'Create a group' : 'Start a conversation',
    group
      ? 'Members are added directly and can see retained history.'
      : 'Find someone using their exact public handle or app user ID.',
    `<form id="lookup" class="form"><label>Public handle or user ID<input name="query" required placeholder="e.g. kyle"></label><button>Find user</button></form><div id="result"></div><div id="chosen"></div>${group ? '<form id="create-group" class="form"><label>Group name<input name="title" required maxlength="100"></label><button>Create group</button></form>' : ''}`,
  );
  document.querySelector('#lookup').onsubmit = async (e) => {
    e.preventDefault();
    try {
      const query = new FormData(e.target).get('query').trim().replace(/^@/, '');
      const user = await api(
        `/users/lookup?${/^[a-f\d]{24}$/i.test(query) ? 'id' : 'handle'}=${encodeURIComponent(query)}`,
      );
      const el = document.querySelector('#result');
      if (!el) return;
      if (!user || user.id === state.me.id) {
        el.textContent = 'No other user found';
        return;
      }
      el.innerHTML = `<div class="user-result">${avatar(user.displayName, user.avatarUrl)}<span>${escape(user.displayName)} <small>@${escape(user.handle)}</small></span><button id="choose-user">${group ? 'Add' : 'Chat'}</button></div>`;
      document.querySelector('#choose-user').onclick = async () => {
        try {
          if (group) {
            chosen.set(user.id, user);
            document.querySelector('#chosen').innerHTML = [...chosen.values()]
              .map(
                (u) =>
                  `<button class="chip" data-remove="${u.id}">${escape(u.displayName)} ×</button>`,
              )
              .join('');
            document.querySelectorAll('[data-remove]').forEach(
              (b) =>
                (b.onclick = () => {
                  chosen.delete(b.dataset.remove);
                  b.remove();
                }),
            );
          } else {
            const c = await post('/conversations/direct', { targetUserId: user.id });
            go(`/conversations/${c._id}`);
            scheduleList();
          }
        } catch (e) {
          showError(e);
        }
      };
    } catch (e) {
      showError(e);
    }
  };
  if (group)
    document.querySelector('#create-group').onsubmit = async (e) => {
      e.preventDefault();
      try {
        const c = await post('/conversations/group', {
          title: new FormData(e.target).get('title'),
          userIds: [...chosen.keys()],
        });
        go(`/conversations/${c._id}`);
        scheduleList();
      } catch (e) {
        showError(e);
      }
    };
}
async function detailsScreen(id, version) {
  let c;
  try {
    c = await api(`/conversations/${id}`, { signal: state.abort.signal });
  } catch (e) {
    if (e.status === 403) {
      state.cache.delete(id);
      go('/conversations', true);
    }
    throw e;
  }
  if (version !== state.version) return;
  state.details = c;
  const owner = c.ownerId === state.me.id,
    admin = owner || c.membership.role === 'admin';
  card(
    escape(title(c)),
    'Conversation settings and membership',
    `<a class="button" data-link href="/conversations/${id}">← Back to chat</a><div class="settings-row"><label><input id="mute" type="checkbox" ${c.membership.muted ? 'checked' : ''}> Mute notifications</label><button id="archive">${c.membership.archivedAt ? 'Unarchive' : 'Archive'}</button></div>${c.type === 'group' && admin ? `<form id="rename" class="form inline"><input name="title" value="${escape(c.title)}" maxlength="100" required><button>Rename</button></form><form id="add-member" class="form inline"><input name="userId" placeholder="Registered user's app ID" required><button>Add member</button></form><p class="muted">Added members can see all retained history.</p>` : ''}<h3>Members</h3><div class="members">${c.members.map((m) => `<div class="member">${avatar(m.user.displayName, m.user.avatarUrl)}<div><strong>${escape(m.user.displayName)}</strong><small>@${escape(m.user.handle)} · ${m.userId === c.ownerId ? 'Owner' : m.role}</small></div>${c.type === 'group' && owner && m.userId !== state.me.id ? `<button data-role="${m.userId}" data-next="${m.role === 'admin' ? 'member' : 'admin'}">${m.role === 'admin' ? 'Demote' : 'Make admin'}</button><button data-transfer="${m.userId}">Make owner</button>` : ''}${c.type === 'group' && m.userId !== c.ownerId && m.userId !== state.me.id && admin && (owner || m.role !== 'admin') ? `<button class="danger" data-remove="${m.userId}">Remove</button>` : ''}</div>`).join('')}</div>${c.type === 'group' ? `<button id="leave" class="danger" ${owner ? 'disabled' : ''}>Leave group</button>${owner ? '<p class="muted">Transfer ownership before leaving.</p>' : ''}` : ''}`,
  );
  const perform = (fn) => async () => {
    try {
      await fn();
      await detailsScreen(id, state.version);
      scheduleList();
    } catch (e) {
      showError(e);
    }
  };
  document.querySelector('#mute').onchange = perform(() =>
    post(
      `/conversations/${id}/preferences`,
      { muted: document.querySelector('#mute').checked },
      'PATCH',
    ),
  );
  document.querySelector('#archive').onclick = perform(() =>
    post(`/conversations/${id}/preferences`, { archived: !c.membership.archivedAt }, 'PATCH'),
  );
  if (admin && c.type === 'group') {
    document.querySelector('#rename').onsubmit = (e) => {
      e.preventDefault();
      perform(() =>
        post(`/conversations/${id}`, { title: new FormData(e.target).get('title') }, 'PATCH'),
      )();
    };
    document.querySelector('#add-member').onsubmit = (e) => {
      e.preventDefault();
      perform(() =>
        post(`/conversations/${id}/members`, {
          userId: new FormData(e.target).get('userId').trim(),
        }),
      )();
    };
  }
  document
    .querySelectorAll('[data-role]')
    .forEach(
      (b) =>
        (b.onclick = perform(() =>
          post(`/conversations/${id}/members/${b.dataset.role}`, { role: b.dataset.next }, 'PATCH'),
        )),
    );
  document
    .querySelectorAll('[data-transfer]')
    .forEach(
      (b) =>
        (b.onclick = perform(() =>
          post(`/conversations/${id}/transfer-owner`, { userId: b.dataset.transfer }),
        )),
    );
  document
    .querySelectorAll('[data-remove]')
    .forEach(
      (b) =>
        (b.onclick = perform(() =>
          api(`/conversations/${id}/members/${b.dataset.remove}`, { method: 'DELETE' }),
        )),
    );
  const leave = document.querySelector('#leave');
  if (leave)
    leave.onclick = async () => {
      try {
        await api(`/conversations/${id}/members/${state.me.id}`, { method: 'DELETE' });
        go('/conversations');
      } catch (e) {
        showError(e);
      }
    };
}
function profile() {
  card(
    'Your profile',
    'Share your handle so others can find you.',
    `<div class="profile-avatar">${avatar(state.me.displayName, state.me.avatarUrl)}</div><form id="profile" class="form"><label>Display name<input name="displayName" maxlength="60" required value="${escape(state.me.displayName)}"></label><label>Public handle<input name="handle" pattern="[a-z0-9_]{3,24}" required value="${escape(state.me.handle)}"></label><label>Avatar HTTPS URL<input name="avatarUrl" type="url" value="${escape(state.me.avatarUrl || '')}"></label><button>Save profile</button></form><p class="muted">Your app ID: <code>${state.me.id}</code></p><button id="logout" class="danger">Sign out</button>`,
  );
  document.querySelector('#profile').onsubmit = async (e) => {
    e.preventDefault();
    try {
      const data = Object.fromEntries(new FormData(e.target));
      data.avatarUrl ||= null;
      state.me = await post('/me', data, 'PATCH');
      toast('Profile saved');
      await render();
    } catch (e) {
      showError(e);
    }
  };
  document.querySelector('#logout').onclick = () => logout().catch(showError);
}
function preferencesScreen() {
  const p = prefs();
  card(
    'Make it yours',
    'Preferences apply to this browser.',
    `<div class="theme-options">${themes.map((t) => `<button class="theme-preview ${t}" data-theme="${t}" aria-pressed="${document.documentElement.dataset.theme === t}">${t}</button>`).join('')}</div><div class="settings-row"><label><input id="sound" type="checkbox" ${p.sound !== false ? 'checked' : ''}> Notification sounds</label></div><div class="settings-row"><label><input id="notifications" type="checkbox" ${p.notifications ? 'checked' : ''}> Desktop notifications</label></div><p class="muted">Desktop notifications work while this app is open. Your browser controls permission.</p>`,
  );
  document.querySelectorAll('button[data-theme]').forEach(
    (b) =>
      (b.onclick = () => {
        document.documentElement.dataset.theme = b.dataset.theme;
        localStorage.setItem('relay.theme', b.dataset.theme);
        document
          .querySelectorAll('button[data-theme]')
          .forEach((option) => option.setAttribute('aria-pressed', String(option === b)));
      }),
  );
  document.querySelector('#sound').onchange = (e) =>
    localStorage.setItem(
      'relay.preferences',
      JSON.stringify({ ...prefs(), sound: e.target.checked }),
    );
  document.querySelector('#notifications').onchange = async (e) => {
    const allowed =
      !e.target.checked ||
      ('Notification' in window && (await Notification.requestPermission()) === 'granted');
    e.target.checked = allowed && e.target.checked;
    localStorage.setItem(
      'relay.preferences',
      JSON.stringify({ ...prefs(), notifications: e.target.checked }),
    );
    if (!allowed) toast('Notifications were not allowed by the browser');
  };
}
async function render() {
  const version = ++state.version;
  state.abort?.abort();
  state.abort = new AbortController();
  const previous = state.active;
  state.active = null;
  state.details = null;
  state.history = null;
  if (previous && state.socket?.connected) emit('conversation:unsubscribe', {}).catch(() => {});
  if (!state.me) {
    root.innerHTML = `<div class="login"><div class="brand"><span class="brand-icon">R</span>Relay</div><div class="eyebrow">A LITTLE CLOSER, EVERY DAY</div><h1>Your people.<br>Your conversations.</h1><p>A quiet space for direct chats and private groups.</p><button id="login">Continue with Google ↗</button><small>Your conversations are visible only to their members.</small></div>`;
    document.querySelector('#login').onclick = async () => {
      try {
        await signInWithPopup(firebaseAuth, new GoogleAuthProvider());
      } catch (e) {
        showError(e);
      }
    };
    return;
  }
  if (location.pathname === '/login' || location.pathname === '/') {
    go('/conversations', true);
    return;
  }
  shell();
  const path = location.pathname;
  if (path === '/conversations/new') newConversation();
  else if (path === '/groups/new') newConversation(true);
  else if (path === '/settings/profile') profile();
  else if (path === '/settings/preferences') preferencesScreen();
  else if (/^\/conversations\/[a-f\d]{24}\/details$/.test(path))
    await detailsScreen(path.split('/')[2], version);
  else if (/^\/conversations\/[a-f\d]{24}$/.test(path)) await chat(path.split('/')[2], version);
  else if (path === '/conversations')
    card(
      'Good to see you.',
      'Pick a conversation, or start something new.',
      '<div class="welcome-mark">↗</div><a class="button primary" data-link href="/conversations/new">Start a conversation</a> <a class="button" data-link href="/groups/new">Create a group</a>',
    );
  else
    card(
      'Page not found',
      'This link does not point to a Relay screen.',
      '<a class="button" data-link href="/conversations">Back to conversations</a>',
    );
  sidebar();
}
document.addEventListener('click', (e) => {
  const link = e.target.closest('a[data-link]');
  if (link && !e.ctrlKey && !e.metaKey) {
    e.preventDefault();
    go(link.getAttribute('href'));
  }
});
window.addEventListener('popstate', () => render().catch(showError));
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    scheduleRead();
    if (state.active && state.user)
      catchup(state.active, contiguousSeq(state.active))
        .then(() => timeline(false))
        .catch(showError);
  }
});
window.addEventListener('focus', scheduleRead);
document.querySelector('#close-lightbox').onclick = () =>
  document.querySelector('#lightbox').close();
try {
  const config = await (await fetch('/api/config')).json();
  firebaseAuth = getAuth(initializeApp(config.firebase));
  let uid = null;
  onIdTokenChanged(firebaseAuth, async (user) => {
    if (logoutInProgress) return;
    if (user?.uid === uid && state.me) return;
    uid = user?.uid || null;
    const intended = location.pathname;
    clearPrivate();
    if (!user) {
      await render();
      return;
    }
    state.user = user;
    const epoch = state.epoch;
    try {
      state.me = await api('/me');
      await refreshList();
      await connect(user);
      if (intended !== '/login') await render();
      else go('/conversations', true);
    } catch (e) {
      if (epoch !== state.epoch) return;
      clearPrivate();
      showError(e);
      await render();
    }
  });
} catch (e) {
  root.innerHTML =
    '<div class="loading">Firebase configuration is missing. Set the environment variables and restart the server.</div>';
  console.error(e.name);
}
