const app = require('./app');
const config = require('./config');

// Validate critical environment configuration
if (!config.aiApiKey) {
  console.error('FATAL: AI_API_KEY environment variable is not set. Aborting.');
  process.exit(1);
}

const server = app.listen(config.port, () => {
  console.log(`AI Gateway running on port ${config.port}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down...');
  server.close(() => {
    console.log('Process terminated');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down...');
  server.close(() => {
    console.log('Process terminated');
    process.exit(0);
  });
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  process.exit(1);
});
