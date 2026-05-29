require('dotenv').config();

const { MODELS } = require('../../shared/aiPricing');

const config = {
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  GOOGLE_MAPS_API_KEY: process.env.GOOGLE_MAPS_API_KEY,
  SERVICE_ACCOUNT_KEY_PATH: process.env.SERVICE_ACCOUNT_KEY_PATH,
  WHOLESALE_SHEET_ID: process.env.WHOLESALE_SHEET_ID,
  AI_MODEL: process.env.AI_MODEL || MODELS.HAIKU,
  SCORE_THRESHOLD: parseInt(process.env.SCORE_THRESHOLD || '5', 10),
};

module.exports = config;
