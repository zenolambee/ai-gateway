const crypto = require('crypto');

/**
 * Request ID middleware.
 *
 * Generates a unique identifier for every incoming request and attaches it to
 * `req.requestId`. If the client sends an `x-request-id` header, that value
 * is forwarded as-is (useful for distributed tracing). Otherwise a random
 * id is generated. The same value is mirrored back in the `x-request-id`
 * response header so callers can correlate logs and responses.
 *
 * @param {object} [opts]
 * @param {string} [opts.header='x-request-id'] - header to read/forward
 */
function requestId(opts = {}) {
  const header = (opts.header || 'x-request-id').toLowerCase();

  return (req, res, next) => {
    const incoming = req.headers[header];
    const id = incoming && typeof incoming === 'string'
      ? incoming
      : crypto.randomBytes(16).toString('hex');

    req.requestId = id;
    res.setHeader('X-Request-Id', id);
    next();
  };
}

module.exports = requestId;
