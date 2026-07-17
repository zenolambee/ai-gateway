const express = require('express');
const router = express.Router();

// Static list of supported models (can be replaced with dynamic config in the future)
const models = [
  {
    id: 'gpt-4',
    name: 'GPT-4',
    provider: 'OpenAI',
    capabilities: ['text-generation', 'chat'],
  },
  {
    id: 'gpt-3.5-turbo',
    name: 'GPT-3.5 Turbo',
    provider: 'OpenAI',
    capabilities: ['text-generation', 'chat'],
  },
  {
    id: 'claude-2',
    name: 'Claude 2',
    provider: 'Anthropic',
    capabilities: ['text-generation', 'chat'],
  },
  {
    id: 'palm-2',
    name: 'PaLM 2',
    provider: 'Google',
    capabilities: ['text-generation', 'chat'],
  },
];

router.get('/', (req, res) => {
  res.status(200).json({ models });
});

module.exports = router;
