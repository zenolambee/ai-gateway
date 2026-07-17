/**
 * Application‑wide configuration that is not environment‑specific.
 * Override or extend values via environment variables in config.js.
 */
const appConfig = {
  name: 'AI Gateway',
  version: '1.0.0',
  description: 'A professional API Gateway for AI services',
  defaultModel: 'deepseek-v4-flash',
  pagination: {
    defaultLimit: 10,
    maxLimit: 100,
  },
  allowedOrigins: '*', // Can be overridden by CORS settings
};

module.exports = appConfig;
