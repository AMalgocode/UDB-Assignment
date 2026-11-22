'use strict';

require('dotenv').config();
const { createClient } = require('redis');

let client = null;
let isConnected = false;

/**
 * Configure and return the Redis client instance.
 * Supports standard TCP (redis://) and Unix domain sockets (unix:///path/to/socket).
 */
function createRedisClient(customUrl = null) {
  const redisUrl = customUrl || process.env.REDIS_URL || 'redis://localhost:6379';

  const newClient = createClient({
    url: redisUrl,
    socket: {
      reconnectStrategy: (retries) => {
        // Stop retrying after 10 attempts in testing/offline mode
        if (retries > 10) {
          return new Error('Redis max reconnection attempts exceeded');
        }
        // Exponential backoff capped at 3000ms
        return Math.min(retries * 100, 3000);
      },
      connectTimeout: 5000,
    },
  });

  newClient.on('connect', () => {
    // Connection established
  });

  newClient.on('ready', () => {
    isConnected = true;
  });

  newClient.on('error', (err) => {
    isConnected = false;
    // Log error internally without exposing credentials
    if (process.env.NODE_ENV !== 'test') {
      console.error(`[Redis Error] ${err.message}`);
    }
  });

  newClient.on('end', () => {
    isConnected = false;
  });

  return newClient;
}

/**
 * Get or initialize the singleton Redis client
 */
function getRedisClient() {
  if (!client) {
    client = createRedisClient();
  }
  return client;
}

/**
 * Connect to Redis
 */
async function connectRedis() {
  const redisClient = getRedisClient();
  if (!redisClient.isOpen) {
    await redisClient.connect();
    isConnected = true;
  }
  return redisClient;
}

/**
 * Disconnect from Redis gracefully
 */
async function disconnectRedis() {
  if (client && client.isOpen) {
    await client.quit();
    isConnected = false;
    client = null;
  }
}

/**
 * Check if Redis is actively connected
 */
function isRedisConnected() {
  return isConnected && client !== null && client.isOpen;
}

/**
 * Execute Redis ping with latency measurement
 */
async function pingRedis() {
  const redisClient = getRedisClient();
  if (!redisClient.isOpen) {
    throw new Error('Redis client is not connected');
  }
  const start = Date.now();
  const reply = await redisClient.ping();
  const latencyMs = Date.now() - start;
  return { reply, latencyMs };
}

module.exports = {
  createRedisClient,
  getRedisClient,
  connectRedis,
  disconnectRedis,
  isRedisConnected,
  pingRedis,
};
