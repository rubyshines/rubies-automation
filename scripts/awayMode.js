#!/usr/bin/env node
/**
 * Away mode control — the out-of-office acknowledgment sent on first contact.
 *
 *   node scripts/awayMode.js                                  # status
 *   node scripts/awayMode.js on --until "2026-08-10 08:00" --back "Sunday, August 9"
 *   node scripts/awayMode.js off
 *   node scripts/awayMode.js preview --back "Sunday, August 9"
 *
 * --until is when the flag STOPS being read as enabled (interpreted in Eastern
 * Time). It is the whole safety design: away mode disarms itself, so coming
 * home is not a thing anyone has to remember. Required when turning it on.
 *
 * --back is the customer-facing return phrase, rendered as "out of town until
 * <phrase>". Keep --back a little earlier than --until so the promise is met
 * before the acknowledgment stops going out.
 */

require('dotenv').config();
const { getFlag, setFlag } = require('../shared/systemFlags');
const {
  AWAY_FLAG, buildAwayAck, DEFAULT_RETURN_PHRASE, parseEastern, formatEastern: fmtET,
} = require('../customer-service/lib/awayMode');

function argValue(args, name) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : null;
}

async function status() {
  const flag = await getFlag(AWAY_FLAG);
  if (!flag) {
    console.log('Away mode: OFF (no flag row yet — run away-mode-schema.sql)');
    return;
  }
  const state = flag.active ? 'ON' : 'OFF';
  console.log(`Away mode: ${state}`);
  console.log(`  enabled flag : ${flag.enabled}`);
  console.log(`  expires at   : ${fmtET(flag.expires_at)}`);
  console.log(`  return phrase: ${flag.note || `(none, will say "${DEFAULT_RETURN_PHRASE}")`}`);
  if (flag.enabled && !flag.active) {
    console.log('\n  The window has passed, so nothing is being sent. Nothing to do.');
  }
}

async function main() {
  const args = process.argv.slice(2);
  const cmd = (args[0] || 'status').toLowerCase();

  if (cmd === 'status') return status();

  if (cmd === 'preview') {
    const phrase = argValue(args, '--back') || DEFAULT_RETURN_PHRASE;
    console.log(buildAwayAck(phrase).text);
    return;
  }

  if (cmd === 'off') {
    await setFlag(AWAY_FLAG, false, null, null);
    console.log('Away mode: OFF. Takes effect everywhere within 60s (flag cache TTL).');
    return;
  }

  if (cmd === 'on') {
    const untilRaw = argValue(args, '--until');
    const back = argValue(args, '--back');
    if (!untilRaw) {
      console.error('--until is required. It is what switches away mode back off by itself.');
      console.error('  e.g. node scripts/awayMode.js on --until "2026-08-10 08:00" --back "Sunday, August 9"');
      process.exit(1);
    }
    const until = parseEastern(untilRaw);
    if (!until) {
      console.error(`Could not read --until "${untilRaw}". Use "YYYY-MM-DD HH:mm" (ET) or a full ISO string.`);
      process.exit(1);
    }
    if (until.getTime() <= Date.now()) {
      console.error(`--until ${fmtET(until.toISOString())} is in the past, so away mode would never send. Aborting.`);
      process.exit(1);
    }
    if (!back) {
      console.warn(`No --back phrase given, so the email will say "${DEFAULT_RETURN_PHRASE}".`);
    }

    await setFlag(AWAY_FLAG, true, back || null, until.toISOString());

    console.log(`Away mode: ON until ${fmtET(until.toISOString())} (it switches itself off then).`);
    console.log('Live everywhere within 60s (flag cache TTL).\n');
    console.log('First-contact customers will receive:\n');
    console.log(buildAwayAck(back || DEFAULT_RETURN_PHRASE).text);
    return;
  }

  console.error(`Unknown command "${cmd}". Use: status | on | off | preview`);
  process.exit(1);
}

main().catch(err => { console.error(err.message); process.exit(1); });
