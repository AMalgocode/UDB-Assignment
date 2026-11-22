'use strict';

const request = require('supertest');
const app = require('../src/app');
const { connectRedis, disconnectRedis, getRedisClient } = require('../src/config/redis');
const rateLimitService = require('../src/services/rateLimitService');

describe('API Integration & Rate Limiter HTTP Tests', () => {
  let redisClient;
  const LOCAL_IP = '127.0.0.1';

  beforeAll(async () => {
    redisClient = await connectRedis();
  });

  afterAll(async () => {
    await rateLimitService.resetClientLimit(LOCAL_IP);
    await disconnectRedis();
  });

  beforeEach(async () => {
    await rateLimitService.resetClientLimit(LOCAL_IP);
  });

  describe('GET /', () => {
    test('returns service discovery and status 200', async () => {
      const res = await request(app).get('/');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.endpoints).toBeDefined();
    });
  });

  describe('GET /api (Sliding Window Rate Limiting)', () => {
    test('1. First request is accepted with HTTP 200 and standard rate limit headers', async () => {
      const res = await request(app).get('/api');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.status).toBe('allowed');

      // Check RateLimit headers
      expect(res.headers['ratelimit-limit']).toBe('5');
      expect(res.headers['ratelimit-remaining']).toBe('4');
      expect(res.headers['ratelimit-reset']).toBeDefined();
      expect(Number(res.headers['ratelimit-reset'])).toBeGreaterThan(0);
    });

    test('2. Requests within limit are accepted, decrementing remaining quota', async () => {
      for (let i = 1; i <= 5; i++) {
        const res = await request(app).get('/api');
        expect(res.status).toBe(200);
        expect(res.headers['ratelimit-limit']).toBe('5');
        expect(res.headers['ratelimit-remaining']).toBe(String(5 - i));
      }
    });

    test('3. Request exceeding limit returns HTTP 429 with Retry-After header', async () => {
      // Consume all 5 requests
      for (let i = 0; i < 5; i++) {
        await request(app).get('/api');
      }

      // 6th request must be rejected
      const res = await request(app).get('/api');

      expect(res.status).toBe(429);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('TOO_MANY_REQUESTS');
      expect(res.body.error.details.retryAfterSeconds).toBeGreaterThan(0);

      // Verify headers
      expect(res.headers['retry-after']).toBeDefined();
      expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
      expect(res.headers['ratelimit-remaining']).toBe('0');
    });

    test('8. Concurrent HTTP requests cannot exceed configured limit', async () => {
      // Fire 10 concurrent requests
      const promises = Array.from({ length: 10 }, () => request(app).get('/api'));
      const responses = await Promise.all(promises);

      const status200 = responses.filter((r) => r.status === 200);
      const status429 = responses.filter((r) => r.status === 429);

      expect(status200.length).toBe(5);
      expect(status429.length).toBe(5);
    });
  });

  describe('GET /api/rate-limit/status', () => {
    test('returns status without consuming request capacity', async () => {
      // Make 1 request to /api
      await request(app).get('/api');

      // Query status twice
      const statusRes1 = await request(app).get('/api/rate-limit/status');
      expect(statusRes1.status).toBe(200);
      expect(statusRes1.body.data.currentUsage).toBe(1);
      expect(statusRes1.body.data.remainingRequests).toBe(4);

      const statusRes2 = await request(app).get('/api/rate-limit/status');
      expect(statusRes2.status).toBe(200);
      expect(statusRes2.body.data.currentUsage).toBe(1);
      expect(statusRes2.body.data.remainingRequests).toBe(4);

      // Then verify /api still has 4 remaining
      const apiRes = await request(app).get('/api');
      expect(apiRes.status).toBe(200);
      expect(apiRes.headers['ratelimit-remaining']).toBe('3');
    });
  });

  describe('GET /api/health', () => {
    test('10. Reports healthy status and Redis connectivity when online', async () => {
      const res = await request(app).get('/api/health');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.status).toBe('healthy');
      expect(res.body.data.database.connected).toBe(true);
      expect(typeof res.body.data.database.latencyMs).toBe('number');
    });
  });

  describe('Fail-Closed Reliability on Redis Failure', () => {
    test('9. Does not silently bypass rate limiter when Redis is unavailable', async () => {
      // Temporarily mock rateLimitService.checkRateLimit to throw a connection error
      const originalCheck = rateLimitService.checkRateLimit;
      rateLimitService.checkRateLimit = jest.fn().mockRejectedValue(new Error('Connection lost to Redis'));

      try {
        const res = await request(app).get('/api');

        // MUST NOT be 200 (fail-closed security principle)
        expect(res.status).toBe(503);
        expect(res.body.success).toBe(false);
        expect(res.body.error.code).toBe('RATE_LIMITER_UNAVAILABLE');
      } finally {
        rateLimitService.checkRateLimit = originalCheck;
      }
    });

    test('Health check returns HTTP 503 when Redis check fails', async () => {
      const redisConfig = require('../src/config/redis');

      const originalIsConnected = redisConfig.isRedisConnected;
      redisConfig.isRedisConnected = jest.fn().mockReturnValue(false);

      try {
        const res = await request(app).get('/api/health');
        expect(res.status).toBe(503);
        expect(res.body.success).toBe(false);
        expect(res.body.error.code).toBe('SERVICE_UNHEALTHY');
      } finally {
        redisConfig.isRedisConnected = originalIsConnected;
      }
    });

    test('Health check handles unexpected exception during ping', async () => {
      const redisConfig = require('../src/config/redis');
      const originalIsConnected = redisConfig.isRedisConnected;
      const originalPing = redisConfig.pingRedis;

      redisConfig.isRedisConnected = jest.fn().mockReturnValue(true);
      redisConfig.pingRedis = jest.fn().mockRejectedValue(new Error('Network timeout'));

      try {
        const res = await request(app).get('/api/health');
        expect(res.status).toBe(503);
        expect(res.body.success).toBe(false);
        expect(res.body.error.code).toBe('HEALTH_CHECK_FAILED');
      } finally {
        redisConfig.isRedisConnected = originalIsConnected;
        redisConfig.pingRedis = originalPing;
      }
    });

    test('Rate limit status returns HTTP 503 when Redis check fails', async () => {
      const originalStatus = rateLimitService.getRateLimitStatus;
      rateLimitService.getRateLimitStatus = jest.fn().mockRejectedValue(new Error('Redis down'));

      try {
        const res = await request(app).get('/api/rate-limit/status');
        expect(res.status).toBe(503);
        expect(res.body.success).toBe(false);
        expect(res.body.error.code).toBe('RATE_LIMITER_UNAVAILABLE');
      } finally {
        rateLimitService.getRateLimitStatus = originalStatus;
      }
    });
  });

  describe('IP Extraction & Normalization', () => {
    const { getClientIp } = require('../src/middleware/rateLimiter');

    test('normalizes IPv4-mapped IPv6 address', () => {
      const req = { ip: '::ffff:192.168.1.5', socket: {} };
      expect(getClientIp(req)).toBe('192.168.1.5');
    });

    test('normalizes IPv6 loopback to 127.0.0.1', () => {
      const req = { ip: '::1', socket: {} };
      expect(getClientIp(req)).toBe('127.0.0.1');
    });

    test('falls back to socket IP if req.ip is invalid', () => {
      const req = { ip: 'not-an-ip', socket: { remoteAddress: '10.0.0.1' } };
      expect(getClientIp(req)).toBe('10.0.0.1');
    });

    test('falls back to 127.0.0.1 if both req.ip and socket are invalid', () => {
      const req = { ip: 'invalid', socket: { remoteAddress: 'also-invalid' } };
      expect(getClientIp(req)).toBe('127.0.0.1');
    });
  });

  describe('Response Utility', () => {
    const { sendSuccess } = require('../src/utils/response');

    test('supports optional meta payload in sendSuccess', () => {
      const res = {
        statusCode: null,
        data: null,
        status(code) {
          this.statusCode = code;
          return this;
        },
        json(payload) {
          this.data = payload;
          return this;
        },
      };

      sendSuccess(res, 200, 'All good', { item: 1 }, { page: 1, total: 10 });
      expect(res.statusCode).toBe(200);
      expect(res.data.meta).toEqual({ page: 1, total: 10 });
    });
  });

  describe('404 Route handling', () => {
    test('returns 404 for undefined routes', async () => {
      const res = await request(app).get('/api/non-existent-route');
      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('NOT_FOUND');
    });
  });
});
