import 'dotenv/config';
export function config(env = process.env) {
  const required = (key) => {
    if (!env[key]) throw new Error(`Missing ${key}`);
    return env[key];
  };
  return {
    port: Number(env.PORT || 3000),
    origin: required('APP_ORIGIN'),
    devOrigin: env.DEV_ORIGIN || 'http://localhost:5173',
    mongoUri: required('MONGODB_URI'),
    dbName: env.MONGODB_DB || 'chat',
    redisUrl: env.REDIS_URL,
    cacheEnabled: env.CACHE_ENABLED === 'true',
    firebaseProjectId: required('FIREBASE_PROJECT_ID'),
    firebaseCredentials: env.FIREBASE_ADMIN_CREDENTIALS,
    browserFirebase: {
      apiKey: env.FIREBASE_API_KEY,
      authDomain: env.FIREBASE_AUTH_DOMAIN,
      projectId: env.FIREBASE_PROJECT_ID,
      appId: env.FIREBASE_APP_ID,
    },
    s3: {
      region: env.S3_REGION || 'auto',
      endpoint: env.S3_ENDPOINT || undefined,
      bucket: env.S3_BUCKET,
      forcePathStyle: env.S3_FORCE_PATH_STYLE === 'true',
      credentials:
        env.S3_ACCESS_KEY_ID && env.S3_SECRET_ACCESS_KEY
          ? { accessKeyId: env.S3_ACCESS_KEY_ID, secretAccessKey: env.S3_SECRET_ACCESS_KEY }
          : undefined,
    },
    production: env.NODE_ENV === 'production',
  };
}
