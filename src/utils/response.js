'use strict';

/**
 * Standardized successful JSON response
 */
function sendSuccess(res, statusCode = 200, message = 'Success', data = null, meta = null) {
  const payload = {
    success: true,
    message,
    timestamp: new Date().toISOString(),
  };

  if (data !== null) {
    payload.data = data;
  }

  if (meta !== null) {
    payload.meta = meta;
  }

  return res.status(statusCode).json(payload);
}

/**
 * Standardized error JSON response
 */
function sendError(res, statusCode = 500, code = 'INTERNAL_ERROR', message = 'An unexpected error occurred', details = null) {
  const payload = {
    success: false,
    error: {
      code,
      message,
    },
    timestamp: new Date().toISOString(),
  };

  if (details !== null) {
    payload.error.details = details;
  }

  return res.status(statusCode).json(payload);
}

module.exports = {
  sendSuccess,
  sendError,
};
