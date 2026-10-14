import { test, expect } from '@playwright/test';
const alice = 'a'.repeat(24),
  bob = 'b'.repeat(24),
  cid = 'c'.repeat(24);
const me = { id: alice, displayName: 'Kyle', handle: 'kyle', avatarUrl: null };
const members = [
  { userId: alice, role: 'member', lastReadSeq: 0, joinedAfterSeq: 0, user: me },
  {
    userId: bob,
    role: 'member',
    lastReadSeq: 0,
    joinedAfterSeq: 0,
    user: { id: bob, displayName: 'Sam', handle: 'sam' },
  },
];
const conversation = {
  _id: cid,
  type: 'direct',
  lastSeq: 1,
  membership: { muted: false, archivedAt: null },
  members,
  unread: 1,
};
async function setup(page, signedIn = true, avatarUrl = null) {
  const profile = { ...me, avatarUrl };
  const chat = structuredClone(conversation);
  chat.members.forEach((member) => {
    member.user.avatarUrl = avatarUrl;
  });
  await page.addInitScript(
    ({ signedIn, conversation, me }) => {
      window.socketCount = 0;
      window.testConversation = conversation;
      window.testMe = me;
      window.reads = [];
      window.failSend = false;
      window.nextSeq = 1;
      let authCallback;
      const user = { uid: 'test-user', getIdToken: async () => 'fake-test-token' };
      window.testAuth = {
        getAuth: () => ({}),
        onIdTokenChanged: (_, cb) => {
          authCallback = cb;
          queueMicrotask(() => cb(signedIn ? user : null));
        },
        GoogleAuthProvider: class {},
        signInWithPopup: async () => authCallback(user),
        signOut: async () => authCallback(null),
      };
      window.testIO = () => {
        window.socketCount++;
        const handlers = new Map();
        const socket = {
          connected: false,
          auth: {},
          io: { on() {} },
          on(event, fn) {
            handlers.set(event, fn);
            return socket;
          },
          removeAllListeners() {
            handlers.clear();
          },
          disconnect() {
            socket.connected = false;
            return socket;
          },
          connect() {
            socket.connected = true;
            queueMicrotask(() => handlers.get('connect')?.());
            return socket;
          },
          timeout() {
            return socket;
          },
          emit(event, payload, ack) {
            if (event === 'chat_message') {
              if (window.failSend) {
                ack(null, { ok: false, error: 'Offline test' });
                return;
              }
              const message = {
                ...payload,
                _id: crypto.randomUUID(),
                senderId: me.id,
                seq: ++window.nextSeq,
                createdAt: new Date().toISOString(),
              };
              ack(null, { ok: true, data: message });
              handlers.get('chat_message')?.({ conversationId: payload.conversationId, message });
            } else {
              if (event === 'messages_read') window.reads.push(payload.seq);
              ack(null, {
                ok: true,
                data:
                  event === 'conversation:subscribe'
                    ? { ...conversation, onlineUserIds: [] }
                    : { ok: true },
              });
            }
          },
          trigger(event, value) {
            handlers.get(event)?.(value);
          },
        };
        window.testSocket = socket;
        return socket;
      };
    },
    { signedIn, conversation: chat, me: profile },
  );
  await page.route('**/api/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    const data =
      path === '/api/config'
        ? { firebase: {} }
        : path === '/api/me'
          ? profile
          : path === '/api/conversations'
            ? [chat]
            : path.endsWith('/messages')
              ? {
                  messages: [
                    {
                      _id: 'message1',
                      conversationId: cid,
                      seq: 1,
                      senderId: bob,
                      clientMessageId: 'message1-client',
                      type: 'text',
                      content: '<script>danger</script> Hi Kyle',
                      createdAt: new Date().toISOString(),
                    },
                  ],
                  highWaterSeq: 1,
                  retainedFromSeq: 1,
                  hasMore: false,
                }
              : path.includes('/users/lookup')
                ? { id: bob, displayName: 'Sam', handle: 'sam', avatarUrl }
                : chat;
    return route.fulfill({ json: data });
  });
}
test('auth waits, sign-in and routes preserve one socket across back/forward', async ({ page }) => {
  await setup(page, false);
  await page.goto(`/conversations/${cid}`);
  await expect(page.locator('#login')).toBeVisible();
  await page.locator('#login').click();
  await expect(page.locator('#timeline')).toBeVisible();
  await expect(page.locator('.bubble')).toContainText('<script>danger</script>');
  expect(await page.evaluate(() => window.danger)).toBeUndefined();
  await page.getByRole('link', { name: 'Details', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Members' })).toBeVisible();
  await page.goBack();
  await expect(page.locator('#timeline')).toBeVisible();
  await page.goForward();
  await expect(page.getByRole('heading', { name: 'Members' })).toBeVisible();
  expect(await page.evaluate(() => window.socketCount)).toBe(1);
});
test('send reconciliation, pending retry survives navigation, removal clears conversation', async ({
  page,
}) => {
  await setup(page);
  await page.goto(`/conversations/${cid}`);
  await expect(page.locator('#draft')).toBeVisible();
  await page.locator('#draft').fill('First message');
  await page.locator('#draft').press('Enter');
  await expect(page.locator('.bubble').filter({ hasText: 'First message' })).toHaveCount(1);
  await page.evaluate(() => {
    window.failSend = true;
  });
  await page.locator('#draft').fill('Retry me');
  await page.locator('#draft').press('Enter');
  await expect(page.getByText('Failed · Retry')).toBeVisible();
  await page.getByRole('link', { name: 'Details', exact: true }).click();
  await page.goBack();
  await expect(page.getByText('Failed · Retry')).toBeVisible();
  await page.evaluate(() => {
    window.failSend = false;
  });
  await page.getByText('Failed · Retry').click();
  await expect(page.locator('.bubble').filter({ hasText: 'Retry me' })).toHaveCount(1);
  await page.evaluate(
    (cid) => window.testSocket.trigger('conversation_removed', { conversationId: cid }),
    cid,
  );
  await expect(page).toHaveURL('/conversations');
  await expect(page.locator('#timeline')).toHaveCount(0);
});
test('fixed routes, themes, deep refresh, not-found and logout state clearing', async ({
  page,
}) => {
  await setup(page);
  await page.goto('/conversations/new');
  await expect(page.getByRole('heading', { name: 'Start a conversation' })).toBeVisible();
  await page.locator('input[name=query]').fill('sam');
  await page.getByRole('button', { name: 'Find user' }).click();
  await expect(page.locator('#choose-user')).toBeVisible();
  await page.goto('/settings/preferences');
  await page.getByRole('button', { name: 'light', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.goto('/unknown');
  await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
  await page.goto('/settings/profile');
  await page.locator('#logout').click();
  await expect(page.locator('#login')).toBeVisible();
  await expect(page.locator('#conversations')).toHaveCount(0);
  expect(await page.evaluate(() => window.testSocket.connected)).toBe(false);
});
test('responsive chat renders without horizontal overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await setup(page);
  await page.goto(`/conversations/${cid}`);
  await expect(page.locator('#composer')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});
test('live sequence gaps recover before advancing read-through positions', async ({ page }) => {
  await setup(page);
  let release;
  const blocked = new Promise((r) => {
    release = r;
  });
  let requested = false;
  await page.route('**/api/conversations/*/messages?afterSeq=*', async (route) => {
    requested = true;
    await blocked;
    await route.fulfill({
      json: {
        messages: [
          {
            _id: 'message2',
            conversationId: cid,
            seq: 2,
            senderId: bob,
            type: 'text',
            content: 'Recovered missing message',
            createdAt: new Date().toISOString(),
          },
        ],
        highWaterSeq: 3,
        retainedFromSeq: 1,
        hasMore: false,
      },
    });
  });
  await page.goto(`/conversations/${cid}`);
  await expect(page.locator('#timeline')).toBeVisible();
  await page.bringToFront();
  await page.evaluate(
    (cid) =>
      window.testSocket.trigger('chat_message', {
        conversationId: cid,
        message: {
          _id: 'message3',
          conversationId: cid,
          seq: 3,
          senderId: 'b'.repeat(24),
          type: 'text',
          content: 'Live third message',
          createdAt: new Date().toISOString(),
        },
      }),
    cid,
  );
  await expect.poll(() => requested).toBe(true);
  await page.waitForTimeout(700);
  expect(await page.evaluate(() => window.reads.includes(3))).toBe(false);
  release();
  await expect(page.getByText('Recovered missing message', { exact: false })).toBeVisible();
  await expect(page.locator('.bubble')).toHaveCount(3);
});

test('profile photos render across chat, members, profile and user lookup; failures fall back', async ({
  page,
}) => {
  const url = 'https://avatars.example.test/profile.png';
  await page.route(url, (route) =>
    route.fulfill({
      contentType: 'image/png',
      body: Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXioAAAAASUVORK5CYII=',
        'base64',
      ),
    }),
  );
  await setup(page, true, url);
  await page.goto(`/conversations/${cid}`);
  for (const selector of ['.account', '.conversation', '.header-person', '.sender']) {
    const image = page.locator(`${selector} .avatar-photo`);
    await expect(image).toHaveAttribute('src', url);
    await expect
      .poll(() => image.evaluate((img) => img.complete && img.naturalWidth > 0))
      .toBe(true);
  }
  await page.getByRole('link', { name: 'Details', exact: true }).click();
  await expect(page.locator('.member .avatar-photo')).toHaveCount(2);
  await page.goto('/settings/profile');
  await expect(page.locator('.profile-avatar .avatar-photo')).toHaveAttribute('src', url);
  await page.goto('/conversations/new');
  await page.locator('input[name=query]').fill('sam');
  await page.getByRole('button', { name: 'Find user' }).click();
  await expect(page.locator('.user-result .avatar-photo')).toHaveAttribute('src', url);
  await page.route(url, (route) => route.abort());
  await page.reload();
  await expect(page.locator('.account .avatar-photo')).toHaveCount(0);
  await expect(page.locator('.account .avatar-initials')).toHaveText('K');
});
test('new themes persist with selected state and Arsenal typography', async ({ page }) => {
  await setup(page);
  await page.goto('/settings/preferences');
  await expect(page.locator('.theme-preview')).toHaveCount(8);
  for (const theme of ['forest', 'ocean', 'rose', 'sunset']) {
    await page.getByRole('button', { name: theme, exact: true }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await expect(page.locator('.theme-preview[aria-pressed="true"]')).toHaveCount(1);
    await page.reload();
    await expect(page.getByRole('button', { name: theme, exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  }
  expect(await page.evaluate(() => getComputedStyle(document.body).fontFamily)).toContain(
    'Arsenal',
  );
  await expect(page.locator('link[href*="family=Arsenal"]')).toHaveCount(1);
});

test('link cards load safely and links retain query parameters', async ({ page }) => {
  await setup(page);
  const url = 'https://example.com/article?a=1&b=2';
  await page.route('**/api/conversations/*/messages?authoritative=true', (route) =>
    route.fulfill({
      json: {
        messages: [
          {
            _id: 'd'.repeat(24),
            conversationId: cid,
            seq: 1,
            senderId: bob,
            type: 'text',
            content: `See (${url}), <script>bad</script>`,
            createdAt: new Date().toISOString(),
          },
        ],
        highWaterSeq: 1,
        retainedFromSeq: 1,
        hasMore: false,
      },
    }),
  );
  await page.route('**/api/conversations/*/messages/*/preview', (route) =>
    route.fulfill({
      json: {
        preview: {
          url,
          title: '<img src=x onerror=alert(1)> Article',
          description: 'A & B',
          siteName: 'Example',
          image: null,
        },
      },
    }),
  );
  await page.goto(`/conversations/${cid}`);
  await expect(page.locator('.bubble a')).toHaveAttribute('href', url);
  await expect(page.locator('.link-preview')).toBeVisible();
  await expect(page.locator('.link-preview strong')).toHaveText(
    '<img src=x onerror=alert(1)> Article',
  );
  await expect(page.locator('.link-preview img')).toHaveCount(0);
  await page.route('**/api/conversations/*/messages/*/preview', (route) =>
    route.fulfill({ json: { preview: null } }),
  );
  await page.reload();
  await expect(page.locator('.bubble a')).toHaveAttribute('href', url);
  await expect(page.locator('.link-preview')).toHaveCount(0);
});
