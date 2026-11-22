'use strict';

class ServiceError extends Error {
  constructor(status, code, message, details = {}) {
    super(message);
    this.name = 'ServiceError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function errorBody(error) {
  if (error instanceof ServiceError) {
    return {
      error: error.message,
      code: error.code,
      ...(Object.keys(error.details).length ? { details: error.details } : {}),
    };
  }
  return { error: 'Internal error', code: 'INTERNAL_ERROR' };
}

function mapDatabaseError(error) {
  if (error && error.code === '23P01') {
    return new ServiceError(409, 'BOOKING_OVERLAP', 'The event time overlaps an existing booking.');
  }
  if (error && error.code === '23514') {
    return new ServiceError(400, 'VALIDATION_ERROR', 'The requested change violates a booking rule.');
  }
  if (error && error.code === '23505') {
    const constraint = error.constraint || '';
    if (/charge|refund|idempotency|unique/i.test(constraint)) {
      return new ServiceError(409, 'INVALID_TRANSITION', 'The request has already been applied.');
    }
    return new ServiceError(409, 'VALIDATION_ERROR', 'A unique value is already in use.');
  }
  return new ServiceError(500, 'INTERNAL_ERROR', 'Internal error');
}

module.exports = { ServiceError, errorBody, mapDatabaseError };
