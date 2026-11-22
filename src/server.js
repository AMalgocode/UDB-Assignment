'use strict';

require('dotenv').config();
const app = require('./app');
const { connectRedis, disconnectRedis } = require('./config/redis');

const PORT = parseInt(process.env.PORT || '3000', 10);

let server;

async function startServer() {
  try {
    console.log('[Startup] Connecting to Redis...');
    await connectRedis();
    console.log('[Startup] Connected to Redis successfully.');

    server = app.listen(PORT, () => {
      console.log(`[Startup] Rate Limiter Server running on http://localhost:${PORT}`);
      console.log(`[Startup] Environment: ${process.env.NODE_ENV || 'development'}`);
      console.log(
        `[Startup] Rate Limit Settings: max ${process.env.RATE_LIMIT_MAX_REQUESTS || 5} requests / ${
          process.env.RATE_LIMIT_WINDOW_MS || 60000
        }ms`
      );
    });
  } catch (err) {
    console.error(`[Startup Fatal Error] Failed to initialize server: ${err.message}`);
    process.exit(1);
  }
}

/**
 * Graceful shutdown procedure
 */
async function gracefulShutdown(signal) {
  console.log(`\n[Shutdown] Received ${signal}. Closing server gracefully...`);

  if (server) {
    server.close(async () => {
      console.log('[Shutdown] HTTP server closed.');
      try {
        await disconnectRedis();
        console.log('[Shutdown] Redis connection closed.');
        process.exit(0);
      } catch (err) {
        console.error(`[Shutdown Error] Error closing Redis: ${err.message}`);
        process.exit(1);
      }
    });

    // Force exit if graceful shutdown takes longer than 10 seconds
    setTimeout(() => {
      console.error('[Shutdown] Forced shutdown after timeout.');
      process.exit(1);
    }, 10000).unref();
  } else {
    process.exit(0);
  }
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

process.on('unhandledRejection', (reason) => {
  console.error('[Unhandled Rejection]', reason);
});

process.on('uncaughtException', (err) => {
  console.error('[Uncaught Exception]', err);
  process.exit(1);
});

// Start the server if executed directly
if (require.main === module) {
  startServer();
}

module.exports = { startServer, gracefulShutdown };
