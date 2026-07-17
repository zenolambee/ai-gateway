const AppError = require('../utils/AppError');

function errorHandler(err, req, res, next) {
  let status = 500;
  let message = 'Internal Server Error';

  if (err instanceof AppError) {
    status = err.statusCode;
    message = err.message;
  } else if (err.status) {
    status = err.status;
    message = err.message || 'Unknown Error';
  } else {
    console.error('Unexpected error:', err);
  }

  res.status(status).json({
    error: {
      message,
      status,
    },
  });
}

module.exports = errorHandler;
