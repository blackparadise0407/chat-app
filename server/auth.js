import { initializeApp, cert, applicationDefault } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { ObjectId } from 'mongodb';
import { fail, publicUser } from './core.js';
export function firebaseVerifier(cfg) {
  const app = initializeApp({
    projectId: cfg.firebaseProjectId,
    credential: cfg.firebaseCredentials
      ? cert(JSON.parse(cfg.firebaseCredentials))
      : applicationDefault(),
  });
  return (token) => getAuth(app).verifyIdToken(token, true);
}
export function createAuth(db, verify) {
  const users = db.collection('users');
  async function authenticate(token) {
    if (typeof token !== 'string' || token.length > 10000) fail(401, 'Sign in required');
    let claims;
    try {
      claims = await verify(token);
    } catch {
      fail(401, 'Session expired or revoked');
    }
    if (!claims.uid || claims.exp * 1000 <= Date.now()) fail(401, 'Session expired');
    const now = new Date();
    const _id = new ObjectId();
    try {
      await users.updateOne(
        { firebaseUid: claims.uid },
        {
          $setOnInsert: {
            _id,
            firebaseUid: claims.uid,
            displayName: String(claims.name || 'New user').slice(0, 60),
            avatarUrl:
              typeof claims.picture === 'string' && claims.picture.startsWith('https://')
                ? claims.picture
                : null,
            handle: `user_${_id.toString().slice(-12)}`,
            createdAt: now,
            updatedAt: now,
          },
        },
        { upsert: true },
      );
    } catch (e) {
      if (e.code !== 11000) throw e;
    }
    const user = await users.findOne({ firebaseUid: claims.uid });
    return { user, userId: user._id, exp: claims.exp, token };
  }
  async function http(req, res, next) {
    try {
      req.identity = await authenticate(
        req.headers.authorization?.startsWith('Bearer ')
          ? req.headers.authorization.slice(7)
          : null,
      );
      next();
    } catch (e) {
      next(e);
    }
  }
  return { authenticate, http, publicUser };
}
