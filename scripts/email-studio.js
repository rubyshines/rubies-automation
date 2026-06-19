#!/usr/bin/env node
/**
 * email-studio.js — CLI to test the email studio MCP tools without the server.
 * Invokes the real tool handlers, so output matches what the operator console gets.
 *
 *   node scripts/email-studio.js ideas "summer swim" [count] [months]
 *   node scripts/email-studio.js subjects "back to school sale" [count] [months]
 *   node scripts/email-studio.js draft "how no-tuck swimwear works" [segment] [months]
 *   node scripts/email-studio.js calendar "July 2026"
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const tools = require('../customer-service/lib/tools/emailStudio');

const MAP = {
  ideas: { name: 'email_campaign_ideas', build: (a, p2, p3) => ({ theme: a, count: p2 ? +p2 : 5, ...(p3 ? { months: +p3 } : {}) }) },
  subjects: { name: 'email_subject_lab', build: (a, p2, p3) => ({ topic: a, count: p2 ? +p2 : 8, ...(p3 ? { months: +p3 } : {}) }) },
  draft: { name: 'email_campaign_draft', build: (a, p2, p3) => ({ brief: a, segment: p2 || 'customers', ...(p3 ? { months: +p3 } : {}) }) },
  calendar: { name: 'email_calendar_plan', build: (a) => ({ period: a }) },
};

(async () => {
  const [cmd, arg, p2, p3] = process.argv.slice(2);
  const spec = MAP[cmd];
  if (!spec || !arg) {
    console.log('Usage: node scripts/email-studio.js <ideas|subjects|draft|calendar> "<input>" [count/segment] [months]');
    process.exit(1);
  }
  const tool = tools.find((t) => t.name === spec.name);
  const res = await tool.handler(spec.build(arg, p2, p3));
  console.log(res.content[0].text);
})().catch((e) => { console.error('Error:', e.message); process.exit(1); });
