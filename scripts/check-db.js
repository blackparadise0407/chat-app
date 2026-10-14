import 'dotenv/config';
import { MongoClient, ObjectId } from 'mongodb';

if (!process.env.MONGODB_URI) {
  console.error('Set MONGODB_URI in .env first.');
  process.exit(1);
}
const client = new MongoClient(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 5000 });
let session;
try {
  await client.connect();
  const db = client.db(process.env.MONGODB_DB || 'relay');
  await db.command({ ping: 1 });
  const hello = await db.admin().command({ hello: 1 });
  if (!hello.setName || !hello.isWritablePrimary) {
    throw new Error('A writable MongoDB replica set is required. Start it with npm run db:up.');
  }
  // Collection creation happens outside the transaction; no probe document is committed.
  const collection = db.collection('_connectionCheck');
  const sessionId = new ObjectId();
  if (!(await db.listCollections({ name: collection.collectionName }).hasNext())) {
    try {
      await db.createCollection(collection.collectionName);
    } catch (error) {
      if (error.code !== 48) throw error;
    }
  }
  session = client.startSession();
  session.startTransaction();
  await collection.insertOne({ _id: sessionId }, { session });
  await session.abortTransaction();
  if (await collection.findOne({ _id: sessionId })) throw new Error('Transaction rollback failed.');
  console.log(
    `MongoDB connected: ${db.databaseName}; replica set ${hello.setName}; transaction rollback verified.`,
  );
} catch (error) {
  // Driver error messages can contain server addresses; do not echo the URI or credentials.
  console.error('MongoDB check failed:', error.name === 'Error' ? error.message : error.name);
  console.error('Check Docker Desktop, npm run db:up, docker compose logs mongo, and MONGODB_URI.');
  process.exitCode = 1;
} finally {
  if (session?.inTransaction()) await session.abortTransaction().catch(() => {});
  await session?.endSession();
  await client.close();
}
