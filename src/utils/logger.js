/**
 * Simple logging utility that wraps console with a timestamp and level.
 * In a production environment you can swap this out with a dedicated
 * logging library (e.g., winston, pino) without changing the rest of
 * the application.
 */

const levels = {
  INFO: 'INFO',
  WARN: 'WARN',
  ERROR: 'ERROR',
};

const timestamp = () => new Date().toISOString();

function log(level, message, meta) {
  const entry = { timestamp: timestamp(), level, message };
  if (meta) {
    entry.meta = meta;
  }
  if (level === levels.ERROR) {
    console.error(JSON.stringify(entry));
  } else if (level === levels.WARN) {
    console.warn(JSON.stringify(entry));
  } else {
    console.log(JSON.stringify(entry));
  }
}

const logger = {
  info: (message, meta) => log(levels.INFO, message, meta),
  warn: (message, meta) => log(levels.WARN, message, meta),
  error: (message, meta) => log(levels.ERROR, message, meta),
};

module.exports = logger;
