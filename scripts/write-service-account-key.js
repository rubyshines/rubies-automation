#!/usr/bin/env node

/**
 * Writes the SERVICE_ACCOUNT_KEY env var to a JSON file on disk.
 * Google APIs (Search Console, GA4, Sheets) require a file path.
 *
 * On GitHub Actions this is done inline in the workflow YAML.
 * On Railway this runs as a pre-step before any Google API script.
 *
 * Usage:
 *   node scripts/write-service-account-key.js && node seo-tracking/daily-seo-tracking.js
 */

const fs = require('fs');
const path = require('path');

const KEY_PATH = path.join(__dirname, '..', 'service-account-key.json');

if (process.env.SERVICE_ACCOUNT_KEY) {
  fs.writeFileSync(KEY_PATH, process.env.SERVICE_ACCOUNT_KEY);
  console.log('Service account key written to', KEY_PATH);
} else if (fs.existsSync(KEY_PATH)) {
  console.log('Service account key already exists at', KEY_PATH);
} else {
  console.warn('WARNING: No SERVICE_ACCOUNT_KEY env var and no key file found. Google API calls will fail.');
}
