const logger = require('../utils/logger');

// Express identifies this as error-handling middleware specifically because
// it takes 4 arguments (err first) - must be registered LAST, after every
// route, so anything forwarded via next(err) (including from asyncHandler)
// ends up here instead of Express's default plain-text error page.
function errorHandler(err, req, res, next) {
  logger.error('Unhandled request error', {
    method: req.method,
    path: req.originalUrl,
    message: err.message,
    // Stack traces are useful in your own logs, but never sent to the
    // client - that would leak internal file paths and code structure.
    stack: err.stack,
  });

  const status = err.status || 500;
  res.status(status).json({
    error: status === 500 ? 'Something went wrong on our end. Please try again.' : err.message,
  });
}

module.exports = errorHandler;
