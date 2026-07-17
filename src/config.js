require('dotenv').config();

let modelsList = [];
try {
  modelsList = JSON.parse(process.env.MODELS_LIST);
} catch (e) {
  // fallback to a default if parsing fails or env not set
  modelsList = [{ id: 'deepseek-v4-flash', object: 'model' }];
}

const config = {
  port: parseInt(process.env.PORT, 10) || 3000,
  nodeEnv: process.env.NODE_ENV || 'development',
  version: process.env.VERSION || '1.0.0',
  modelsList,
};

module.exports = config;
