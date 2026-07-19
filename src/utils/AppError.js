class AppError extends Error {
  constructor(message, statusCode, info = {}) {
    super(message);
    this.statusCode = statusCode;
    this.isOperational = true;
    this.info = info;
    Error.captureStackTrace(this, this.constructor);
  }
}

module.exports = AppError;
