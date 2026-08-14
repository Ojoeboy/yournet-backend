// Simple structured logger - no external dependency, but consistent format
// (timestamp, level, message, optional context) instead of scattered plain
// console.log calls. Swappable for Winston/Pino later without touching
// every call site, since everything goes through these four functions.

function log(level, message, context) {
  const entry = {
    time: new Date().toISOString(),
    level,
    message,
    ...(context ? { context } : {}),
  };
  const line = JSON.stringify(entry);
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

module.exports = {
  info: (message, context) => log('info', message, context),
  warn: (message, context) => log('warn', message, context),
  error: (message, context) => log('error', message, context),
};
