'use strict';

const express = require('express');
const router = express.Router();

const { createRateLimiter, getClientIp } = require('../middleware/rateLimiter');
const rateLimitService = require('../services/rateLimitService');
const redisConfig = require('../config/redis');
const { sendSuccess, sendError } = require('../utils/response');

// Default rate limiter middleware instance for protected routes
const standardRateLimiter = createRateLimiter();

/**
 * GET /api
 * Primary application endpoint protected by the Sliding Window Log rate limiter.
 */
router.get('/', standardRateLimiter, (req, res) => {
  const clientIp = getClientIp(req);
  return sendSuccess(res, 200, 'Request processed successfully', {
    clientIp,
    timestamp: new Date().toISOString(),
    service: 'NoSQL Sliding Window Rate Limiter',
    status: 'allowed',
  });
});

/**
 * GET /api/health
 * System health and Redis connectivity verification endpoint.
 * Note: Does not consume rate limit quota.
 */
router.get('/health', async (req, res) => {
  try {
    const isConnected = redisConfig.isRedisConnected();
    let redisPingInfo = null;

    if (isConnected) {
      redisPingInfo = await redisConfig.pingRedis();
    }

    const healthData = {
      status: isConnected ? 'healthy' : 'degraded',
      timestamp: new Date().toISOString(),
      uptimeSeconds: Math.floor(process.uptime()),
      memoryUsage: {
        rssMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
        heapUsedMb: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
      },
      database: {
        engine: 'Redis 7 / Compatible',
        connected: isConnected,
        latencyMs: redisPingInfo ? redisPingInfo.latencyMs : null,
      },
    };

    if (!isConnected) {
      return sendError(
        res,
        503,
        'SERVICE_UNHEALTHY',
        'Redis database is disconnected',
        healthData
      );
    }

    return sendSuccess(res, 200, 'System is healthy', healthData);
  } catch (err) {
    return sendError(
      res,
      503,
      'HEALTH_CHECK_FAILED',
      'Database health check failed',
      { error: err.message }
    );
  }
});

/**
 * GET /api/rate-limit/status
 * Query client's current rate limit metrics without consuming another request.
 */
router.get('/rate-limit/status', async (req, res) => {
  const clientIp = getClientIp(req);

  try {
    const status = await rateLimitService.getRateLimitStatus(clientIp);

    // Provide informational headers
    res.setHeader('RateLimit-Limit', status.limit);
    res.setHeader('RateLimit-Remaining', status.remaining);
    res.setHeader('RateLimit-Reset', status.resetInSeconds);

    return sendSuccess(
      res,
      200,
      'Current rate limit status retrieved successfully',
      {
        clientIp: status.clientIp,
        limit: status.limit,
        currentUsage: status.currentUsage,
        remainingRequests: status.remaining,
        resetInSeconds: status.resetInSeconds,
        windowMs: status.windowMs,
      }
    );
  } catch (err) {
    return sendError(
      res,
      503,
      'RATE_LIMITER_UNAVAILABLE',
      'Could not retrieve rate limit status because Redis is unreachable'
    );
  }
});

module.exports = router;
