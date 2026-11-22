'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { getRedisClient } = require('../config/redis');

// Load Lua scripts into memory
const RATE_LIMIT_SCRIPT = fs.readFileSync(
  path.join(__dirname, '../scripts/rateLimiter.lua'),
  'utf8'
);

const STATUS_SCRIPT = fs.readFileSync(
  path.join(__dirname, '../scripts/rateLimitStatus.lua'),
  'utf8'
);

/**
 * Sanitize client identifier to create a secure Redis key.
 * Removes unwanted characters to prevent Redis key injection.
 */
function sanitizeClientIdentifier(clientIp) {
  if (!clientIp || typeof clientIp !== 'string') {
    return 'unknown';
  }
  // Trim and normalize IPv4-mapped IPv6 addresses (e.g. ::ffff:127.0.0.1 -> 127.0.0.1)
  let normalized = clientIp.trim();
  if (normalized.startsWith('::ffff:')) {
    normalized = normalized.slice(7);
  }
  // Allow alphanumeric, colons (IPv6), dots (IPv4), and dashes
  return normalized.replace(/[^a-zA-Z0-9:.-]/g, '_');
}

/**
 * Generate a Redis key for a given client IP
 */
function getRateLimitKey(clientIp, prefix = 'rate-limit:') {
  const sanitized = sanitizeClientIdentifier(clientIp);
  return `${prefix}${sanitized}`;
}

/**
 * Generate a unique member identifier for each request
 */
function generateMemberId(timestamp) {
  const randomSuffix = crypto.randomBytes(8).toString('hex');
  return `${timestamp}:${randomSuffix}`;
}

/**
 * Evaluate atomic rate limiter Lua script
 *
 * @param {string} clientIp - Client IP address
 * @param {object} options - Configuration overrides
 * @param {number} [options.maxRequests] - Max allowed requests (default from env or 5)
 * @param {number} [options.windowMs] - Window size in ms (default from env or 60000)
 * @param {string} [options.keyPrefix] - Redis key prefix (default 'rate-limit:')
 * @param {object} [options.redisClient] - Optional explicit redis client instance
 * @returns {Promise<object>} Rate limit evaluation result
 */
async function checkRateLimit(clientIp, options = {}) {
  const maxRequests = parseInt(
    options.maxRequests || process.env.RATE_LIMIT_MAX_REQUESTS || 5,
    10
  );
  const windowMs = parseInt(
    options.windowMs || process.env.RATE_LIMIT_WINDOW_MS || 60000,
    10
  );
  const keyPrefix = options.keyPrefix || 'rate-limit:';
  const redis = options.redisClient || getRedisClient();

  if (!redis || !redis.isOpen) {
    throw new Error('Redis connection is unavailable');
  }

  const key = getRateLimitKey(clientIp, keyPrefix);
  const now = options.now || Date.now();
  const memberId = generateMemberId(now);

  const result = await redis.eval(RATE_LIMIT_SCRIPT, {
    keys: [key],
    arguments: [
      String(now),
      String(windowMs),
      String(maxRequests),
      memberId,
    ],
  });

  // Result array: [allowed (0/1), remaining, current_count, retry_after_sec, reset_in_sec]
  const [allowedNum, remaining, currentCount, retryAfterSec, resetInSec] = result;

  return {
    allowed: allowedNum === 1,
    limit: maxRequests,
    remaining: Number(remaining),
    currentUsage: Number(currentCount),
    retryAfter: Number(retryAfterSec),
    resetInSeconds: Number(resetInSec),
    windowMs,
    clientIp,
    key,
  };
}

/**
 * Query client's current rate limit status without consuming a token
 *
 * @param {string} clientIp - Client IP address
 * @param {object} options - Configuration overrides
 * @returns {Promise<object>} Current rate limit status
 */
async function getRateLimitStatus(clientIp, options = {}) {
  const maxRequests = parseInt(
    options.maxRequests || process.env.RATE_LIMIT_MAX_REQUESTS || 5,
    10
  );
  const windowMs = parseInt(
    options.windowMs || process.env.RATE_LIMIT_WINDOW_MS || 60000,
    10
  );
  const keyPrefix = options.keyPrefix || 'rate-limit:';
  const redis = options.redisClient || getRedisClient();

  if (!redis || !redis.isOpen) {
    throw new Error('Redis connection is unavailable');
  }

  const key = getRateLimitKey(clientIp, keyPrefix);
  const now = options.now || Date.now();

  const result = await redis.eval(STATUS_SCRIPT, {
    keys: [key],
    arguments: [
      String(now),
      String(windowMs),
      String(maxRequests),
    ],
  });

  // Result array: [current_count, remaining, reset_in_sec]
  const [currentCount, remaining, resetInSec] = result;

  return {
    limit: maxRequests,
    currentUsage: Number(currentCount),
    remaining: Number(remaining),
    resetInSeconds: Number(resetInSec),
    windowMs,
    clientIp,
    key,
  };
}

/**
 * Reset / purge rate limit records for a client (useful in testing)
 */
async function resetClientLimit(clientIp, options = {}) {
  const keyPrefix = options.keyPrefix || 'rate-limit:';
  const redis = options.redisClient || getRedisClient();
  const key = getRateLimitKey(clientIp, keyPrefix);
  if (redis && redis.isOpen) {
    await redis.del(key);
  }
}

module.exports = {
  checkRateLimit,
  getRateLimitStatus,
  resetClientLimit,
  sanitizeClientIdentifier,
  getRateLimitKey,
  generateMemberId,
};
