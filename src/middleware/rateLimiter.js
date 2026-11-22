'use strict';

const net = require('net');
const rateLimitService = require('../services/rateLimitService');
const { sendError } = require('../utils/response');

/**
 * Extract and validate client IP from request.
 * Respects Express proxy settings (req.ip).
 * Validates format against standard IPv4/IPv6 syntax.
 */
function getClientIp(req) {
  // req.ip respects the Express 'trust proxy' configuration
  let ip = req.ip || req.socket.remoteAddress || '127.0.0.1';

  // Normalize IPv4-mapped IPv6 address (::ffff:127.0.0.1 -> 127.0.0.1)
  if (ip.startsWith('::ffff:')) {
    ip = ip.slice(7);
  }

  // Handle IPv6 localhost
  if (ip === '::1') {
    ip = '127.0.0.1';
  }

  // Basic sanity check: ensure valid IPv4 or IPv6
  if (!net.isIP(ip)) {
    // Fallback to socket remoteAddress if req.ip was malformed
    const socketIp = req.socket && req.socket.remoteAddress;
    if (socketIp && net.isIP(socketIp)) {
      ip = socketIp;
    } else {
      ip = '127.0.0.1';
    }
  }

  return ip;
}

/**
 * Express middleware factory for rate limiting
 *
 * @param {object} [options]
 * @param {number} [options.maxRequests] - Max allowed requests in window
 * @param {number} [options.windowMs] - Window size in milliseconds
 * @param {string} [options.keyPrefix] - Redis key prefix
 */
function createRateLimiter(options = {}) {
  return async function rateLimiterMiddleware(req, res, next) {
    const clientIp = getClientIp(req);

    try {
      const result = await rateLimitService.checkRateLimit(clientIp, options);

      // Always attach standardized RateLimit headers
      res.setHeader('RateLimit-Limit', result.limit);
      res.setHeader('RateLimit-Remaining', result.remaining);
      res.setHeader('RateLimit-Reset', result.resetInSeconds);

      // Legacy X-RateLimit headers for broad HTTP client compatibility
      res.setHeader('X-RateLimit-Limit', result.limit);
      res.setHeader('X-RateLimit-Remaining', result.remaining);
      res.setHeader('X-RateLimit-Reset', result.resetInSeconds);

      if (result.allowed) {
        // Request allowed within quota
        return next();
      }

      // Quota exceeded: set standard Retry-After header in seconds
      res.setHeader('Retry-After', result.retryAfter);

      return sendError(
        res,
        429,
        'TOO_MANY_REQUESTS',
        'Rate limit exceeded. Please try again later.',
        {
          limit: result.limit,
          windowMs: result.windowMs,
          retryAfterSeconds: result.retryAfter,
        }
      );
    } catch (err) {
      // Reliability & Security Rule: Do NOT silently bypass rate limiting when Redis fails.
      // If the backend database is unreachable, fail closed to protect downstream resources.
      if (process.env.NODE_ENV !== 'test') {
        console.error(`[RateLimiter Middleware Error] IP: ${clientIp} - ${err.message}`);
      }

      return sendError(
        res,
        503,
        'RATE_LIMITER_UNAVAILABLE',
        'Rate limiting service is temporarily unavailable. Request declined for safety.'
      );
    }
  };
}

module.exports = {
  createRateLimiter,
  getClientIp,
};
