# Chat App — Implementation Plan v2

Revised draft • 7 October 2026 • Routed SPA, direct and group conversations

## 1. Goal and scope

Upgrade the existing Node.js + Express + Socket.IO chat with Firebase Authentication, MongoDB persistence, and an optional Redis cache. Preserve the existing UI and realtime features. This is an implementation proposal, not a report of completed work.

Initial scope: private 1-to-1 conversations and member-only group rooms; no shared public room. Deploy one Node.js instance on Render, serving the built SPA, static assets, HTTP API, and Socket.IO from the same origin. Use client-side routing for multiple screens. Use a frontend development server with an API/WebSocket proxy during development; production Express serves the built SPA directly. Multiple screens can also work with SSR, but this plan now selects an SPA for persistent navigation and chat state.

### Proposed defaults

- Google sign-in first; email/password can be enabled afterward with verification and password-reset screens.
- MongoDB is the authoritative store for users, conversations, memberships, messages, and read positions.
- Redis is optional and disposable; implement the MongoDB path before enabling caching.
- Load 50 messages initially and 50 per older-history request.
- Apply the original 1,000-message product limit separately to each conversation as a history window. A periodic cleanup removes older database records, so physical storage may temporarily exceed 1,000. Permanent archives are outside this draft.
- Use object storage for new images, with URLs/keys in MongoDB.
- Use HTTPS and provider-managed encryption at rest. Application-level message encryption and end-to-end encryption are not included in this draft; this explicitly changes the original encrypted-file design.

## 2. Responsibilities

| Component | Responsibility |
|---|---|
| Express | Serve the SPA build and route fallback, verify authenticated HTTP requests, expose history/profile/upload endpoints |
| Socket.IO | Deliver messages, read receipts, typing, buzz, and presence events |
| Firebase Authentication | Sign-in, credentials, account recovery, and identity tokens |
| MongoDB | Durable application users, conversations, memberships, message records, and retry deduplication |
| Redis | Optional latest-history cache, expiring presence, and shared cooldowns |
| Object storage | Uploaded image files; choose the provider during implementation |
| Browser SPA | Route screens, render history, maintain auth/conversation state and pending sends, and reconnect |

Remove the authoritative in-memory message queue, encrypted messages.txt writes, content-hash checks, and 30-second autosave loop. Each accepted message is saved immediately.

## 3. Authentication and identity

1. Sign in through the Firebase browser SDK.
2. Obtain a Firebase ID token. Send it as a Bearer token for protected HTTP requests and in the Socket.IO auth payload for connections. Never put tokens in URLs.
3. Verify the token on the server with Firebase Admin, including revoked/disabled-account checks at authentication boundaries.
4. Upsert a MongoDB user by the verified Firebase UID using a unique index.
5. Store the MongoDB user ID on socket.data.userId. Derive all message senders and receipt readers from this identity; ignore client-supplied ownership fields.
6. Authenticate every history/profile/upload request. Check active conversation membership for every conversation action; authentication alone never grants history or room access.
7. Bound socket authorization by token expiry. Refresh the browser token and reconnect with it; reject events after expiry. Disconnect local sockets immediately on logout and propagate logout across tabs.
8. Recheck account status periodically on long-lived connections, with a proposed maximum five-minute revocation window. Document that browser logout alone does not revoke stolen tokens globally.

The SPA HTML shell may be publicly served, but it must not embed private history. Wait for Firebase auth initialization before choosing the login or authenticated route. Client route guards improve navigation only; Express and Socket.IO still enforce authentication and membership. Use Firebase ID tokens for API and socket authentication; server-rendered private pages and session-cookie authentication are outside this plan.

Use MongoDB user IDs in application records so a future auth-provider change does not require rewriting every message. Do not expose emails, tokens, or Firebase credentials in public user payloads.

## 4. MongoDB data model

### users

```js
{
  _id: ObjectId,
  firebaseUid: string,
  displayName: string,
  avatarUrl: string | null,
  createdAt: Date,
  updatedAt: Date
}
```

Index: unique `{ firebaseUid: 1 }`. Store no passwords. Validate display-name length and avatar URL schemes.

### conversations

```js
{
  _id: ObjectId,
  type: "direct" | "group",
  directKey: string,           // direct only; omit for groups
  title: string | null,        // group title
  createdBy: ObjectId,
  ownerId: ObjectId | null,    // group owner; null for direct chats
  lastSeq: number,            // committed message sequence, initially 0
  lastMessageId: ObjectId | null,
  lastMessageAt: Date | null,
  createdAt: Date,
  updatedAt: Date
}
```

For a direct chat, derive directKey on the server by sorting the two distinct MongoDB user IDs and joining them with a delimiter. Enforce a partial unique index on directKey for documents with type="direct". Concurrent attempts by either user return the same conversation. Direct conversations always have exactly two participants and cannot be converted into groups.

### conversationMembers — the user/conversation relationship

```js
{
  _id: ObjectId,
  conversationId: ObjectId,
  userId: ObjectId,
  role: "member" | "admin",    // owner comes from conversations.ownerId
  status: "active" | "left" | "removed",
  joinedAt: Date,
  joinedAfterSeq: number,     // sequence at start of current membership period
  leftAt: Date | null,
  lastReadSeq: number,        // monotonic read-through position
  muted: boolean,
  archivedAt: Date | null,
  createdAt: Date,
  updatedAt: Date
}
```

Relations: users → conversationMembers ← conversations → messages. A user has many conversations; a conversation has many users through membership documents. Keep this as the authoritative relationship, rather than maintaining duplicate conversationIds arrays on users and memberIds arrays on conversations.

Indexes:

- Unique `{ conversationId: 1, userId: 1 }` prevents duplicate memberships.
- `{ userId: 1, status: 1, conversationId: 1 }` supports a user's conversation list.
- `{ conversationId: 1, status: 1 }` supports active-member lookup and authorization.

### messages

```js
{
  _id: ObjectId,
  conversationId: ObjectId,
  seq: number,                // monotonic within this conversation
  senderId: ObjectId,
  clientMessageId: string,
  type: "text" | "image",
  content: string,            // text or stable authenticated media path
  imageKey: string | null,
  createdAt: Date             // server assigned
}
```

Indexes: unique `{ conversationId: 1, seq: 1 }` for order/pagination and unique `{ conversationId: 1, senderId: 1, clientMessageId: 1 }` for retries. Read state belongs on memberships; remove the old readBy arrays.

Use a MongoDB deployment supporting transactions. Within a transaction, check membership, increment conversations.lastSeq, insert the message, and update lastMessageId/lastMessageAt. All membership mutations also write the conversation document in their transaction so concurrent sends and removals serialize through the same record. Retry write conflicts using bounded transaction retries. Emit events only after commit, never from a retryable transaction callback. Avoid calling Redis or storage inside database transactions.

Serialize ObjectIds as strings and dates as ISO strings in API responses. Message IDs identify records; seq provides deterministic per-conversation ordering.

### Membership and permission rules

- Authenticated users can find other registered users by exact public handle or application user ID; add a unique public handle if implementing handle lookup. Do not expose an unrestricted email directory.
- Creating a direct conversation validates the target user and creates both active memberships atomically. Self-chat is outside the initial scope. Direct members cannot add a third user or remove the other member; they can mute or archive locally through their membership settings.
- Group creation requires a title and at least one other valid user. Create the conversation and all memberships atomically; the creator becomes owner.
- Proposed initial policy: owner/admin can add registered users directly, rename the group, and remove ordinary members. Invitation acceptance is deferred; make this behavior visible in the UI.
- Only the owner can grant/revoke admin privileges, remove admins, or transfer ownership. An owner must transfer ownership before leaving, or delete an empty-of-other-members group through a separately defined lifecycle operation; for the initial implementation, disallow sole-owner departure.
- Ordinary group members can leave. Removal/leave immediately revokes history, send, receipt, typing, buzz, and media access. Membership documents remain as inactive records.
- New and re-added group members can see all currently retained history. This is an explicit proposed default. Set joinedAfterSeq and lastReadSeq to the current lastSeq at the start of a new membership period so prior messages do not produce an unread badge, while remaining available in history.
- Read positions describe the current membership period; do not imply that a re-added member read every message while absent. Historical membership audit and exact historical recipient receipts are deferred.
- Archiving hides a conversation from that user's default list; it does not revoke membership or delete shared messages. A new message restores it to the list. Muting suppresses attention notifications only.

## 5. Sending and recovering messages

### Send path

1. Browser generates clientMessageId once, shows a pending bubble, and retains that ID for retries.
2. Server verifies socket authorization and active membership in the requested conversation, validates payload size/type, and enforces send limits.
3. Commit the message, per-conversation sequence, and last-message metadata in the transaction described above.
4. On a duplicate retry, return the existing message. If the same retry ID is reused with different content, reject the conflict.
5. After a successful write, acknowledge with the canonical message and deliver chat_message only to the active members of that conversation. Clients merge by message ID and reconcile pending bubbles by clientMessageId.
6. Invalidate that conversation’s cached latest history with a short timeout. A Redis failure must not convert a saved message into a failed send.

Do not acknowledge success before persistence. A MongoDB failure leaves the message pending/failed with a retry action. A cache failure logs an operational warning and uses the MongoDB path.

### Reconnect and history synchronization

Socket.IO events alone are not durable delivery. A crash after saving but before broadcasting must be recoverable through history.

- Register client event handlers before connecting. Authenticate each socket into a server-controlled `user:<userId>` channel for all that user's tabs/devices.
- Route conversation events to the currently active members' user channels, so users receive messages and list updates even when another conversation is open. A client cannot choose arbitrary user channels.
- Use `conversation:subscribe` to select an active conversation and obtain its authorized snapshot; this subscription is a UI optimization, not an authorization grant. Recheck membership for every subsequent event and request.
- After membership changes commit, revoke active subscriptions, send conversation_removed to the affected user, and clear that conversation's UI data. Resolve current recipients before emitting events; never authorize delivery using a stale Redis membership cache. Serialize mutation and dispatch per conversation in this single-process deployment to avoid post-removal broadcasts.
- On reconnect, reload the authorized conversation list, then fetch messages after each relevant lastReceivedSeq directly from MongoDB. Use a snapshot high-water seq to bound each catch-up, buffer concurrent events, and merge by message ID/seq.
- Retry unacknowledged sends with their original clientMessageId. Recover current membership read positions as well as messages.
- Return a retained-boundary marker when the requested sequence predates retained history. Show that older messages have expired, rather than pretending recovery is complete.

Initial delivery is best effort with database reconciliation, not an exactly-once delivery guarantee. If uninterrupted crash-safe live delivery becomes necessary, add a durable outbox and worker later.

## 6. History and Redis cache

Expose conversation-scoped history using beforeSeq for older pages and afterSeq for reconnect recovery, with validated bounds, default page size 50, and maximum 100. Verify active membership before any database or cache response. Return messages in chronological display order. Do not send all stored messages or Base64 images on connection.

Implement history queries against MongoDB first. When Redis caching is enabled:

- Cache only the latest page under a versioned conversation key, such as chat:v2:conversation:<id>:latest.
- Proposed TTL: 15 seconds. Older pages and reconnect reconciliation read MongoDB directly.
- On a miss, query MongoDB and populate the cache.
- Invalidate after successful message or retention mutations that change the cached payload.
- Accept that concurrent fills and failed invalidations can leave a snapshot stale until TTL expiry. Merge live events with cached results, and use authoritative reads for reconnects.
- If stricter history freshness is needed, disable latest-page caching or implement generation-checked cache fills; do not assume DEL alone prevents races.
- Bound connection/command timeouts and bypass Redis during an outage.

Redis can also hold presence entries per connection with heartbeat expiry and atomic buzz cooldown keys scoped by conversation and sender. Presence is visible only to users sharing an active conversation. Multiple tabs count as one online user. In single-instance mode, fall back to local presence/cooldowns if Redis is unavailable.

Caching, presence, and Socket.IO event distribution are separate concerns. Add the Socket.IO Redis adapter only when deploying multiple Node instances. At that point, define Redis-outage behavior for shared limits and event distribution and configure sticky sessions when HTTP long-polling is enabled.

## 7. Images and existing UX

Use authenticated HTTP uploads instead of embedding Base64 data in messages. Validate file signatures, supported formats, dimensions, and size; a proposed initial upload limit is 5 MiB. Compress oversized images in the browser, but enforce limits again on the server.

Return an upload reference bound to its owner and intended conversation. Upload and message creation both verify active membership; attachment creation verifies ownership and matching conversation. Avoid arbitrary server-side fetches of user-provided image URLs. Use private object storage and a stable authenticated media endpoint that checks active conversation membership before streaming content. Public permanent image URLs are not appropriate for private chats. Do not cache signed URLs in shared message records. Previously downloaded content cannot be revoked.

Clean up abandoned uploads and unreferenced image objects after message-retention cleanup, with a grace period and reference check.

Preserve:

- Dark, Light, Glass, and Midnight themes and local theme preferences.
- Paste/paperclip uploads, thumbnails, and lightbox.
- Consecutive-message grouping and receipt display on the last bubble in a group.
- Typing indicators with expiry so abrupt disconnects do not leave them visible.
- Notification sounds, favicon unread badge, and buzz behavior with a server-enforced 45-second cooldown.
- Desktop notifications subject to browser permission; closed-tab push remains deferred.

Send messages_read with conversationId and a read-through seq only when the active conversation is visible and the user has viewed the contiguous timeline through that point. Validate that the referenced message exists in that conversation and update lastReadSeq monotonically. A read-through marker means earlier messages are considered read; viewing an isolated search result must not advance it. Do not mark history read just because it loaded. In direct chat, show read when the other member’s position reaches the message. In groups, show a count/names of current members who read through it, excluding the sender and requiring message.seq > member.joinedAfterSeq so the initial read-position baseline is not misreported as an actual read. Derive unread badges from retained messages after lastReadSeq sent by other users; do not use lastSeq minus lastReadSeq because that includes own and expired messages. Batch unread queries for the conversation list. Scroll to the bottom when already near it or when sending; otherwise preserve position and show a new-message indicator.

## 8. Proposed interfaces and conversation UI

| Interface | Purpose |
|---|---|
| GET /api/me; PATCH /api/me | Read/update own profile |
| GET /api/users/lookup | Bounded exact public-handle/user-ID lookup |
| GET /api/conversations | Own active memberships, summaries, unread counts; paginated by recent activity |
| POST /api/conversations/direct | Get or create a unique direct chat with targetUserId |
| POST /api/conversations/group | Create a member-only group with title and initial users |
| GET /api/conversations/:id | Authorized metadata and member profiles |
| PATCH /api/conversations/:id | Authorized group metadata changes |
| POST /api/conversations/:id/members | Owner/admin adds a member |
| DELETE /api/conversations/:id/members/:userId | Authorized removal or self-leave |
| PATCH /api/conversations/:id/members/:userId | Owner changes admin role |
| POST /api/conversations/:id/transfer-owner | Atomic ownership transfer |
| PATCH /api/conversations/:id/preferences | Own mute/archive preferences |
| GET /api/conversations/:id/messages | Authorized history and reconnect recovery |
| POST /api/conversations/:id/uploads | Upload an owned, conversation-bound image |
| GET /api/media/:attachmentId | Membership-checked private image delivery |
| conversation:subscribe / unsubscribe | Select/leave an active UI conversation |
| chat_message + acknowledgement | Send/retry with conversationId, then deliver canonical saved message |
| messages_read / read_receipt_update | Advance/broadcast per-member read position |
| typing / stop_typing / buzz | Membership-checked, conversation-scoped events |
| conversation_updated / conversation_removed | Refresh lists, metadata, memberships, and access |
| presence_update | Presence only for authorized shared-conversation peers |

All conversation events carry conversationId. Validate IDs, payload limits, roles, and membership server-side. A guessed conversation ID or forged sender/user ID must grant no access. Avoid disclosing private conversation metadata through error details. Share authorization and history services across HTTP and socket handlers.

Add a conversation sidebar with direct-user avatar/name, group title, recent-message preview, timestamp, unread badge, and mute state. Include new-chat and create-group actions, member management, leave group, and archive controls. Load history only for the selected conversation; retain a bounded client cache per conversation. Group consecutive messages only inside the same conversation. Resolve sender profiles in batched queries, not one query per message.

## 9. Code organization and configuration

Keep handlers thin and split responsibilities into modules:

- server: Express/Socket.IO startup and shutdown.
- auth: Firebase initialization and HTTP/socket verification.
- repositories: MongoDB users, conversations, memberships, and messages.
- services: conversation lifecycle, membership/authorization, message creation, history, read positions, uploads, and per-conversation retention.
- cache: Redis connection and optional cache implementation.
- sockets: event registration and room authorization.
- client: SPA entrypoint, router/screens, shared layout, auth controller, conversation state, and message synchronization.
- client assets: existing styles, themes, sounds, and icons.
- client/dist: generated production frontend build; served by Express.

Configuration includes PORT, APP_ORIGIN, MONGODB_URI, MONGODB_DB, optional REDIS_URL, CACHE_ENABLED, Firebase project/browser settings, server-side Firebase credentials, and image-storage credentials.

Use environment/secret management for server credentials. Firebase browser configuration is public configuration, not an admin credential. Never log tokens, credential files, or message bodies by default. Reuse database connections; fail readiness when MongoDB is unavailable, but allow startup without Redis in single-instance mode.

Deploy one Render Web Service. Build the frontend during deployment, then start only the Node.js production server. Attach Socket.IO and Express to the same HTTP server and listen on the assigned PORT on 0.0.0.0. Serve client/dist and use relative /api URLs and io() in the browser. Do not run the frontend development server in production. No separate frontend deployment or Redis Socket.IO adapter is required. Render plan limits are a deployment-time choice; retain connecting/retry UI for restarts or idle wake-up.

### SPA screens and navigation

| Route | Screen / behavior |
|---|---|
| /login | Google sign-in; optional email/password flows later |
| /conversations | Conversation list and new-chat entry point |
| /conversations/new | Find a user and start a direct chat |
| /groups/new | Create a group and select initial members |
| /conversations/:id | Selected chat, timeline, composer, and realtime state |
| /conversations/:id/details | Group members/settings or direct-chat details |
| /settings/profile | Own display name and avatar settings |
| /settings/preferences | Theme and notification preferences |
| Other frontend paths | SPA not-found screen |

Keep the existing vanilla JavaScript UI; use Vite for the frontend build/dev server and a small client-side router using browser History API. Framework migration is not required. Match fixed paths such as /conversations/new before parameterized routes. Support back/forward navigation, deep links, and refresh on nested routes.

Maintain one authenticated Socket.IO connection at the app-shell level across screen changes. Keep conversation state outside individual screen components. Subscribe/unsubscribe the active conversation on navigation, cancel stale history requests, and remove screen-specific listeners to prevent duplicate events. Navigation must not reset pending sends or create additional sockets.

After sign-in, restore an intended local route only after authorization succeeds; prevent external redirect targets. A removed/inaccessible conversation returns the user to the conversation list and clears its cached client data. On logout or account change, close the socket and clear all private app state, including pending sends, to prevent cross-account leakage. Theme preference may remain local.

### Development proxy and production routing

- Development: run the frontend dev server and Node backend locally. Proxy /api to Node and /socket.io to the same Node server with WebSocket upgrade support. Forward both polling requests and WebSocket upgrades. The browser uses the frontend origin and relative URLs in both environments. Explicitly configure allowed development origins where necessary.
- Production: Express serves the compiled SPA directly. There is no frontend-to-backend proxy process inside the deployment; API and realtime traffic already share the same server and origin.
- Route handling: register API routes and their JSON 404 handler first; let Socket.IO handle its own path; serve built static assets; then return index.html for frontend GET navigation requests. Never return index.html for missing /api, /socket.io, media, or asset requests, or non-GET requests. Ensure SPA navigation requests accept HTML.
- Use long-lived immutable caching for content-hashed assets and revalidation for index.html. Keep private API/media responses out of public caches. Browser-exposed build configuration must contain no MongoDB, Redis, Firebase Admin, or storage secrets.
- Production acceptance: directly opening or refreshing /conversations/:id loads the SPA, then checks auth and membership before requesting private data. Unknown API paths return JSON errors, missing assets return 404, and Socket.IO connects without receiving the HTML fallback.

## 10. Migration

Default: retain legacy public history only as an offline backup. Steps involving database import below apply only if an explicit destination group and membership list are chosen.

1. Back up the existing encrypted file and preserve its real encryption key before removing the old persistence code.
2. Do not automatically expose old public history to new private conversations. Default to keeping it in an offline backup. If import is requested, require an explicit target group and a verified member list; never infer private membership from legacy UUIDs. Write an idempotent one-time importer: decrypt records, validate them, assign real IDs, and preserve original timestamps and assign increasing seq values within the chosen target conversation.
3. Identify imported records with a unique legacy import key so reruns cannot duplicate them.
4. Import previous localStorage identities as explicitly unauthenticated legacy senders. Do not assign their messages to a new Firebase account merely because the browser presents the old UUID.
5. Move legacy Base64 images to object storage with resumable import tracking.
6. Pause old-server writes for final import and cutover; verify retained message count, ordering, image access, and legacy ownership labels.
7. Keep the backup until the new deployment is verified. Rollback after new writes requires exporting/reconciling those writes; restoring only the old file would lose them.

## 11. Implementation phases and acceptance checks

### Phase 1 — SPA shell, Firebase auth, and application users

Implement the frontend build, client router, shared app shell, development API/WebSocket proxy, production fallback, Google sign-in, logout, MongoDB user mapping, and HTTP/socket verification. Verify unauthorized access is rejected, spoofed sender fields are ignored, and expired/revoked sessions lose access within the defined window.

### Phase 2 — Conversations, memberships, messages, and history

Implement direct/group creation, membership permissions, sidebar navigation, transactional messages, read positions, and pagination/reconciliation. Verify simultaneous direct-chat creation produces one conversation with two memberships; transaction failure leaves no orphan conversation or message metadata; retries do not duplicate sends; restart preserves history; sequences paginate deterministically; and a save-before-broadcast crash recovers. Verify nonmembers cannot read/send/subscribe/upload/access media, ordinary members cannot promote themselves, owner transfer is atomic, and removal races cannot leak subsequent events. Test rejoin history policy, multi-tab read synchronization, own-message exclusion in unread badges, and per-conversation retention isolation.

### Phase 3 — Images and migration

Implement owned uploads and storage cleanup, then import legacy data. Verify invalid/oversized uploads are rejected, unauthorized attachment reuse fails, and rerunning the importer creates no duplicates.

### Phase 4 — Redis and temporary state

Enable optional latest-page caching, presence, and cooldowns. Verify message writes invalidate caches and read positions remain fresh, stale snapshots reconcile correctly, multiple tabs produce one online user, and Redis outages do not prevent durable messaging.

### Phase 5 — Regression and deployment

Verify nested-route refresh, deep links, browser back/forward, one socket across screen transitions, listener cleanup, logout state clearing, and existing themes, clamping, notifications, buzz, read receipts, and scroll behavior. Exercise database failures, reconnects, retention boundaries, and logout across tabs. Configure HTTPS, allowed origins, backups, readiness checks, and logging before cutover.

## 12. Deferred scope

Invitation acceptance, contact requests/blocking, group deletion, historical membership audit, permanent archives, message editing/deletion, end-to-end encryption, closed-tab push notifications, multi-instance deployment, durable outbox delivery, and enterprise login are deferred. No infrastructure provisioning or deployment is implied by this draft.

## Reference documentation

- Firebase ID-token verification: https://firebase.google.com/docs/auth/admin/verify-id-tokens
- Firebase Authentication: https://firebase.google.com/docs/auth
- Socket.IO delivery guarantees: https://socket.io/docs/v4/delivery-guarantees/
- Socket.IO Redis adapter: https://socket.io/docs/v4/redis-adapter/
- Redis cache-aside: https://redis.io/docs/latest/develop/use-cases/cache-aside/
- MongoDB indexes: https://www.mongodb.com/docs/manual/reference/indexes/
