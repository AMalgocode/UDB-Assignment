'use strict';

require('dotenv').config();
const express = require('express');
const apiRoutes = require('./routes/api');
const { sendError, sendSuccess } = require('./utils/response');

const app = express();

/**
 * Trust Proxy Configuration:
 * Express allows configuring whether to trust X-Forwarded-* headers.
 * Security Note: Blindly trusting X-Forwarded-For allows malicious clients to spoof
 * arbitrary IP addresses and bypass IP-based rate limiting. Only enable trust proxy
 * when behind a trusted gateway (e.g. Nginx, Cloudflare, AWS ALB).
 */
const trustProxyConfig = process.env.TRUST_PROXY;
if (trustProxyConfig === 'true') {
  app.set('trust proxy', true);
} else if (trustProxyConfig && trustProxyConfig !== 'false') {
  const parsedHops = parseInt(trustProxyConfig, 10);
  app.set('trust proxy', Number.isNaN(parsedHops) ? trustProxyConfig : parsedHops);
} else {
  // Default: do not trust arbitrary forwarded headers
  app.set('trust proxy', false);
}

// Disable x-powered-by header for security hardening
app.disable('x-powered-by');

// Body parsers
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Root welcome & discovery endpoint
app.get('/', (req, res) => {
  return sendSuccess(res, 200, 'Sliding Window Log Rate Limiter Service', {
    endpoints: {
      protectedApi: 'GET /api',
      healthCheck: 'GET /api/health',
      rateLimitStatus: 'GET /api/rate-limit/status',
    },
    version: '1.0.0',
    documentation: 'See README.md for details',
  });
});

// Mount API router
app.use('/api', apiRoutes);

// 404 Route Not Found handler
app.use((req, res) => {
  return sendError(res, 404, 'NOT_FOUND', `Route ${req.method} ${req.originalUrl} not found`);
});

// Centralized error handling middleware
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (process.env.NODE_ENV !== 'test') {
    console.error('[Unhandled Error]', err.message);
  }

  return sendError(
    res,
    err.status || 500,
    err.code || 'INTERNAL_SERVER_ERROR',
    'An internal server error occurred'
  );
});

module.exports = app;
