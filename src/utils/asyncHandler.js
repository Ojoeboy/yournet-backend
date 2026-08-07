// Express 4 does NOT automatically catch errors thrown inside an async
// route handler - an unhandled rejection there can crash the process or
// leave the request hanging. Wrapping every handler in this closes that
// gap: any error gets forwarded to next(err), which the centralized error
// handler in server.js turns into a clean JSON response and a log entry.
//
// Usage: router.post('/', asyncHandler(async (req, res) => { ... }));
function asyncHandler(fn) {
  return function (req, res, next) {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

module.exports = asyncHandler;
