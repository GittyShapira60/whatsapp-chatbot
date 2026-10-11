import Redis from 'ioredis';

const redis = new Redis(process.env.REDIS_URL ?? 'redis://redis:6379', {
  maxRetriesPerRequest: 3,
  lazyConnect: false,
});

redis.on('error', (err) => console.error('[REDIS]', err.message));
redis.on('connect', () => console.log('[REDIS] מחובר ✅'));

export default redis;
