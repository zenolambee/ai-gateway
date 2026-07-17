const app = require('./app');
const config = require('./config');

app.listen(config.port, () => {
  console.log(`AI Gateway running on port ${config.port}`);
});
