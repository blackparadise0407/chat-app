import { MongoClient } from 'mongodb';
export async function connectDatabase(uri, name) {
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 5000 });
  await client.connect();
  const db = client.db(name);
  await createIndexes(db);
  // Fail startup on standalone MongoDB; all durable writes require transactions.
  const hello = await db.admin().command({ hello: 1 });
  if (!hello.setName && hello.msg !== 'isdbgrid') {
    await client.close();
    throw new Error('MongoDB must be a replica set or Atlas cluster');
  }
  return { client, db };
}
export async function createIndexes(db) {
  await Promise.all([
    db.collection('users').createIndex({ firebaseUid: 1 }, { unique: true }),
    db.collection('users').createIndex({ handle: 1 }, { unique: true }),
    db
      .collection('conversations')
      .createIndex({ directKey: 1 }, { unique: true, partialFilterExpression: { type: 'direct' } }),
    db
      .collection('conversationMembers')
      .createIndex({ conversationId: 1, userId: 1 }, { unique: true }),
    db.collection('conversationMembers').createIndex({ userId: 1, status: 1, conversationId: 1 }),
    db.collection('conversationMembers').createIndex({ conversationId: 1, status: 1 }),
    db.collection('messages').createIndex({ conversationId: 1, seq: 1 }, { unique: true }),
    db
      .collection('messages')
      .createIndex({ conversationId: 1, senderId: 1, clientMessageId: 1 }, { unique: true }),
    db.collection('attachments').createIndex({ createdAt: 1 }),
  ]);
}
export async function transaction(client, fn) {
  // Core API gives a bounded retry budget rather than retrying indefinitely.
  for (let attempt = 0; attempt < 5; attempt++) {
    const session = client.startSession();
    try {
      session.startTransaction({
        readConcern: { level: 'snapshot' },
        writeConcern: { w: 'majority' },
        maxCommitTimeMS: 5000,
      });
      const value = await fn(session);
      for (let commit = 0; ; commit++) {
        try {
          await session.commitTransaction();
          break;
        } catch (e) {
          if (commit < 4 && e.hasErrorLabel?.('UnknownTransactionCommitResult')) continue;
          throw e;
        }
      }
      return value;
    } catch (e) {
      if (session.inTransaction()) await session.abortTransaction().catch(() => {});
      if (attempt < 4 && e.hasErrorLabel?.('TransientTransactionError')) continue;
      throw e;
    } finally {
      await session.endSession();
    }
  }
}
