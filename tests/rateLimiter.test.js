'use strict';

const { connectRedis, disconnectRedis, getRedisClient } = require('../src/config/redis');
const rateLimitService = require('../src/services/rateLimitService');

describe('RateLimiter Service (Sliding Window Log)', () => {
  let redisClient;
  const TEST_IP_A = '192.168.1.101';
  const TEST_IP_B = '192.168.1.102';

  beforeAll(async () => {
    redisClient = await connectRedis();
  });

  afterAll(async () => {
    // Clean up test keys
    await rateLimitService.resetClientLimit(TEST_IP_A);
    await rateLimitService.resetClientLimit(TEST_IP_B);
    await disconnectRedis();
  });

  beforeEach(async () => {
    await rateLimitService.resetClientLimit(TEST_IP_A);
    await rateLimitService.resetClientLimit(TEST_IP_B);
  });

  test('1. First request is accepted with correct quota', async () => {
    const res = await rateLimitService.checkRateLimit(TEST_IP_A, {
      maxRequests: 5,
      windowMs: 60000,
    });

    expect(res.allowed).toBe(true);
    expect(res.limit).toBe(5);
    expect(res.remaining).toBe(4);
    expect(res.currentUsage).toBe(1);
    expect(res.retryAfter).toBe(0);
    expect(res.resetInSeconds).toBeGreaterThan(0);
    expect(res.resetInSeconds).toBeLessThanOrEqual(60);
  });

  test('2. Requests within the limit are accepted', async () => {
    const maxRequests = 5;
    for (let i = 1; i <= maxRequests; i++) {
      const res = await rateLimitService.checkRateLimit(TEST_IP_A, {
        maxRequests,
        windowMs: 60000,
      });
      expect(res.allowed).toBe(true);
      expect(res.currentUsage).toBe(i);
      expect(res.remaining).toBe(maxRequests - i);
    }
  });

  test('3. Request exceeding the limit returns allowed = false with retryAfter', async () => {
    const maxRequests = 3;
    const windowMs = 60000;

    // Use up quota
    for (let i = 0; i < maxRequests; i++) {
      await rateLimitService.checkRateLimit(TEST_IP_A, { maxRequests, windowMs });
    }

    // Exceeding request
    const rejected = await rateLimitService.checkRateLimit(TEST_IP_A, { maxRequests, windowMs });

    expect(rejected.allowed).toBe(false);
    expect(rejected.remaining).toBe(0);
    expect(rejected.currentUsage).toBe(maxRequests);
    expect(rejected.retryAfter).toBeGreaterThan(0);
    expect(rejected.retryAfter).toBeLessThanOrEqual(60);
  });

  test('4. Different clients have independent limits', async () => {
    const maxRequests = 2;
    const windowMs = 60000;

    // Client A consumes all 2 requests
    await rateLimitService.checkRateLimit(TEST_IP_A, { maxRequests, windowMs });
    await rateLimitService.checkRateLimit(TEST_IP_A, { maxRequests, windowMs });
    const clientABlocked = await rateLimitService.checkRateLimit(TEST_IP_A, { maxRequests, windowMs });
    expect(clientABlocked.allowed).toBe(false);

    // Client B should still have full quota
    const clientBAllowed = await rateLimitService.checkRateLimit(TEST_IP_B, { maxRequests, windowMs });
    expect(clientBAllowed.allowed).toBe(true);
    expect(clientBAllowed.remaining).toBe(1);
  });

  test('5. Expired requests are removed and window slides forward', async () => {
    const maxRequests = 2;
    const windowMs = 500; // short 500ms window for testing

    const baseTime = Date.now();

    // Consume 2 requests at baseTime
    const r1 = await rateLimitService.checkRateLimit(TEST_IP_A, {
      maxRequests,
      windowMs,
      now: baseTime,
    });
    expect(r1.allowed).toBe(true);

    const r2 = await rateLimitService.checkRateLimit(TEST_IP_A, {
      maxRequests,
      windowMs,
      now: baseTime + 10,
    });
    expect(r2.allowed).toBe(true);

    // At baseTime + 20, limit is exceeded
    const r3 = await rateLimitService.checkRateLimit(TEST_IP_A, {
      maxRequests,
      windowMs,
      now: baseTime + 20,
    });
    expect(r3.allowed).toBe(false);

    // After window expires (baseTime + 550ms), old entries expire and new request is accepted
    const r4 = await rateLimitService.checkRateLimit(TEST_IP_A, {
      maxRequests,
      windowMs,
      now: baseTime + 550,
    });
    expect(r4.allowed).toBe(true);
    expect(r4.currentUsage).toBe(1);
    expect(r4.remaining).toBe(1);
  });

  test('6. Requests are accepted again after the window expires', async () => {
    const maxRequests = 1;
    const windowMs = 300; // 300ms window
    const baseTime = Date.now();

    const first = await rateLimitService.checkRateLimit(TEST_IP_A, {
      maxRequests,
      windowMs,
      now: baseTime,
    });
    expect(first.allowed).toBe(true);

    const second = await rateLimitService.checkRateLimit(TEST_IP_A, {
      maxRequests,
      windowMs,
      now: baseTime + 50,
    });
    expect(second.allowed).toBe(false);

    // Jump past window
    const afterWindow = await rateLimitService.checkRateLimit(TEST_IP_A, {
      maxRequests,
      windowMs,
      now: baseTime + 350,
    });
    expect(afterWindow.allowed).toBe(true);
  });

  test('7. Retry-After is calculated accurately based on oldest timestamp', async () => {
    const maxRequests = 2;
    const windowMs = 10000; // 10 seconds
    const baseTime = 1700000000000;

    // First request at t0
    await rateLimitService.checkRateLimit(TEST_IP_A, {
      maxRequests,
      windowMs,
      now: baseTime,
    });

    // Second request at t0 + 2000ms
    await rateLimitService.checkRateLimit(TEST_IP_A, {
      maxRequests,
      windowMs,
      now: baseTime + 2000,
    });

    // Third request at t0 + 3000ms (rejected)
    // Oldest request was at baseTime, so it expires at baseTime + 10000ms.
    // Time remaining = (baseTime + 10000) - (baseTime + 3000) = 7000ms = 7 seconds
    const rejected = await rateLimitService.checkRateLimit(TEST_IP_A, {
      maxRequests,
      windowMs,
      now: baseTime + 3000,
    });

    expect(rejected.allowed).toBe(false);
    expect(rejected.retryAfter).toBe(7);
  });

  test('8. Concurrent requests cannot exceed the configured limit (atomic lock-free guarantee)', async () => {
    const maxRequests = 5;
    const windowMs = 60000;
    const totalConcurrentRequests = 20;

    // Fire 20 requests concurrently using Promise.all
    const promises = Array.from({ length: totalConcurrentRequests }, () =>
      rateLimitService.checkRateLimit(TEST_IP_A, { maxRequests, windowMs })
    );

    const results = await Promise.all(promises);

    const allowedCount = results.filter((r) => r.allowed === true).length;
    const rejectedCount = results.filter((r) => r.allowed === false).length;

    expect(allowedCount).toBe(maxRequests);
    expect(rejectedCount).toBe(totalConcurrentRequests - maxRequests);
  });

  test('Status check does not consume tokens', async () => {
    const maxRequests = 5;
    const windowMs = 60000;

    // Make 2 requests
    await rateLimitService.checkRateLimit(TEST_IP_A, { maxRequests, windowMs });
    await rateLimitService.checkRateLimit(TEST_IP_A, { maxRequests, windowMs });

    // Check status 3 times
    const s1 = await rateLimitService.getRateLimitStatus(TEST_IP_A, { maxRequests, windowMs });
    const s2 = await rateLimitService.getRateLimitStatus(TEST_IP_A, { maxRequests, windowMs });
    const s3 = await rateLimitService.getRateLimitStatus(TEST_IP_A, { maxRequests, windowMs });

    expect(s1.currentUsage).toBe(2);
    expect(s1.remaining).toBe(3);
    expect(s2.currentUsage).toBe(2);
    expect(s2.remaining).toBe(3);
    expect(s3.currentUsage).toBe(2);
    expect(s3.remaining).toBe(3);
  });

  test('Sanitizes client IP correctly to safe Redis keys', () => {
    expect(rateLimitService.sanitizeClientIdentifier('127.0.0.1')).toBe('127.0.0.1');
    expect(rateLimitService.sanitizeClientIdentifier('::ffff:192.168.1.1')).toBe('192.168.1.1');
    expect(rateLimitService.sanitizeClientIdentifier('2001:db8::1')).toBe('2001:db8::1');
    expect(rateLimitService.sanitizeClientIdentifier('bad IP; FLUSHALL')).toBe('bad_IP__FLUSHALL');
    expect(rateLimitService.sanitizeClientIdentifier(null)).toBe('unknown');
    expect(rateLimitService.sanitizeClientIdentifier('')).toBe('unknown');
  });

  test('Throws descriptive error when Redis client is disconnected', async () => {
    const closedClient = { isOpen: false };
    await expect(
      rateLimitService.checkRateLimit(TEST_IP_A, { redisClient: closedClient })
    ).rejects.toThrow('Redis connection is unavailable');

    await expect(
      rateLimitService.getRateLimitStatus(TEST_IP_A, { redisClient: closedClient })
    ).rejects.toThrow('Redis connection is unavailable');
  });
});
