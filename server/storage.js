import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import sharp from 'sharp';
import { ObjectId } from 'mongodb';
import { fail, oid } from './core.js';
export function createStorage(cfg) {
  const s3 = new S3Client({
    ...cfg.s3,
    requestHandler: { connectionTimeout: 2000, requestTimeout: 10000 },
  });
  const bucket = cfg.s3.bucket;
  const ready = () => {
    if (!bucket) fail(503, 'Image storage is not configured');
  };
  return {
    async put(key, body) {
      ready();
      await s3.send(
        new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: 'image/webp' }),
      );
    },
    async get(key) {
      ready();
      return (await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }))).Body;
    },
    async delete(key) {
      ready();
      await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    },
  };
}
export function createUploads(services, storage) {
  const attachments = services.db.collection('attachments');
  return {
    async upload(id, userId, file) {
      if (!file || file.size > 5 * 1024 * 1024) fail(400, 'Choose an image up to 5 MiB');
      return services.lock.run(id, async () => {
        await services.access(id, userId);
        let body;
        try {
          const image = sharp(file.buffer, { limitInputPixels: 40000000 });
          const metadata = await image.metadata();
          if (
            !['jpeg', 'png', 'webp'].includes(metadata.format) ||
            !metadata.width ||
            !metadata.height ||
            metadata.pages > 1 ||
            metadata.width > 12000 ||
            metadata.height > 12000
          )
            fail(400, 'Use a static JPEG, PNG or WebP up to 40 megapixels');
          body = await image
            .rotate()
            .resize({ width: 2400, height: 2400, fit: 'inside', withoutEnlargement: true })
            .webp({ quality: 85 })
            .toBuffer();
        } catch (e) {
          if (e.status) throw e;
          fail(400, 'Invalid image');
        }
        const _id = new ObjectId(),
          key = `chat/${id}/${_id}.webp`;
        // Reserve metadata first so a crash leaves an object discoverable by cleanup.
        await attachments.insertOne({
          _id,
          key,
          conversationId: oid(String(id)),
          ownerId: userId,
          messageId: null,
          ready: false,
          createdAt: new Date(),
        });
        try {
          await storage.put(key, body);
          await attachments.updateOne({ _id }, { $set: { ready: true } });
        } catch (e) {
          await storage.delete(key).catch(() => {});
          throw e;
        }
        return { attachmentId: String(_id) };
      });
    },
    async media(id, userId) {
      const a = await attachments.findOne({ _id: oid(id) });
      if (!a?.ready) fail(404, 'Image unavailable');
      return services.lock.run(a.conversationId, async () => {
        await services.access(a.conversationId, userId);
        if (!a.messageId && String(a.ownerId) !== String(userId)) fail(403, 'Image unavailable');
        if (
          a.messageId &&
          !(await services.db
            .collection('messages')
            .findOne({
              _id: a.messageId,
              seq: {
                $gte: Math.max(
                  1,
                  (await services.access(a.conversationId, userId)).c.lastSeq - 999,
                ),
              },
            }))
        )
          fail(404, 'Image expired');
        return storage.get(a.key);
      });
    },
  };
}
