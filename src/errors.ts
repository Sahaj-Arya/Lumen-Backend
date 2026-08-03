/**
 * One error type for anything the client is allowed to see. Everything else
 * that escapes a handler becomes a generic 500, so internal messages and stack
 * traces never reach a response body.
 */
export class ApiError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  static badRequest(message: string, details?: unknown) {
    return new ApiError(400, 'bad_request', message, details);
  }
  static unauthorized(message = 'Authentication required') {
    return new ApiError(401, 'unauthorized', message);
  }
  static forbidden(message = 'You do not have access to this resource') {
    return new ApiError(403, 'forbidden', message);
  }
  static notFound(message = 'Not found') {
    return new ApiError(404, 'not_found', message);
  }
  static conflict(message: string) {
    return new ApiError(409, 'conflict', message);
  }
  static tooMany(message = 'Too many requests, slow down') {
    return new ApiError(429, 'rate_limited', message);
  }
  static unavailable(message: string) {
    return new ApiError(503, 'unavailable', message);
  }
}
