const axios = require('axios');
const config = require('../config');
const AppError = require('../utils/AppError');

/**
 * Generate a response from the configured AI provider.
 * @param {string} prompt - The user prompt.
 * @param {string} [model='deepseek-v4-flash'] - Model identifier.
 * @returns {Promise<string>} The generated text.
 */
async function generate(prompt, model = 'deepseek-v4-flash') {
  if (!config.aiApiKey) {
    throw new AppError('AI_API_KEY is not configured', 500);
  }

  try {
    const response = await axios.post(
      config.aiApiUrl,
      {
        model,
        messages: [{ role: 'user', content: prompt }],
        stream: false,
      },
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.aiApiKey}`,
        },
      }
    );

    // Assume the response follows OpenAI‑style format:
    // { choices: [{ message: { content: "..." } }] }
    const content = response.data?.choices?.[0]?.message?.content;
    if (!content) {
      throw new AppError('Empty response from AI provider', 502);
    }

    return content;
  } catch (err) {
    // If it's already an AppError, let it propagate
    if (err instanceof AppError) throw err;

    // Axios error handling
    const status = err.response?.status || 502;
    const message = err.response?.data?.error?.message || err.message || 'AI service unavailable';
    throw new AppError(message, status);
  }
}

module.exports = { generate };
