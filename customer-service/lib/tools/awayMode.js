/**
 * MCP Tool: away_mode
 *
 * Turns the first-contact out-of-office acknowledgment on and off.
 *
 * Exists as a tool because of WHEN this gets used: you switch away mode on
 * while walking out the door, from a phone. The CLI (scripts/awayMode.js) needs
 * a laptop with the repo and .env, which is exactly what you don't have at that
 * moment — the first trip this shipped for, it never got switched on. This makes
 * it reachable from the Ad Hoc Operator tab on the mobile dashboard and from a
 * Claude Code conversation. The CLI stays for desk use; both are thin wrappers
 * over lib/awayMode.js, which owns the behaviour.
 *
 * The `until` guardrail is deliberate and mirrors the CLI: there is no way to
 * enable away mode without an expiry, because the operator who would have to
 * remember to switch it off is by definition unreachable.
 */

const { getFlag, setFlag } = require('../../../shared/systemFlags');
const {
  AWAY_FLAG,
  DEFAULT_RETURN_PHRASE,
  buildAwayAck,
  parseEastern,
  formatEastern,
} = require('../awayMode');

function text(t) { return { content: [{ type: 'text', text: t }] }; }

async function statusText() {
  const flag = await getFlag(AWAY_FLAG);
  if (!flag) {
    return 'Away mode: **OFF** (no flag row — run `customer-service/away-mode-schema.sql`).';
  }
  if (!flag.active) {
    const expiredNote = flag.enabled
      ? `\n\nIt was on, but the window closed ${formatEastern(flag.expires_at)}, so nothing is sending. Nothing to do.`
      : '';
    return `Away mode: **OFF**.${expiredNote}`;
  }
  return [
    'Away mode: **ON**.',
    `- Switches itself off: ${formatEastern(flag.expires_at)}`,
    `- Customers are told you're back: ${flag.note || `(not set, so the email says "${DEFAULT_RETURN_PHRASE}")`}`,
    '',
    'First-contact customers are receiving:',
    '',
    buildAwayAck(flag.note || DEFAULT_RETURN_PHRASE).text,
  ].join('\n');
}

async function handleAwayMode({ action, until, back } = {}) {
  const act = String(action || 'status').toLowerCase();

  if (act === 'status') return text(await statusText());

  if (act === 'preview') {
    const phrase = back || (await getFlag(AWAY_FLAG))?.note || DEFAULT_RETURN_PHRASE;
    return text(`This is what a first-contact customer would receive:\n\n${buildAwayAck(phrase).text}`);
  }

  if (act === 'off') {
    await setFlag(AWAY_FLAG, false, null, null);
    return text('Away mode: **OFF**. Live everywhere within 60s (flag cache TTL).');
  }

  if (act === 'on') {
    if (!until) {
      return text(
        'Need `until` — the moment away mode switches itself back off. That expiry is the '
        + 'whole safety design, so away mode cannot be enabled without one.\n\n'
        + 'Give it as "YYYY-MM-DD HH:mm" in Eastern Time, e.g. "2026-08-10 08:00" for the '
        + 'morning you are back at your desk.'
      );
    }
    const when = parseEastern(until);
    if (!when) {
      return text(`Could not read \`until\` "${until}". Use "YYYY-MM-DD HH:mm" (Eastern) or a full ISO string.`);
    }
    if (when.getTime() <= Date.now()) {
      return text(`\`until\` ${formatEastern(when.toISOString())} is in the past, so away mode would never send. Not enabling.`);
    }

    await setFlag(AWAY_FLAG, true, back || null, when.toISOString());

    const phrase = back || DEFAULT_RETURN_PHRASE;
    const warn = back
      ? ''
      : `\n\n⚠️ No \`back\` phrase given, so the email says "${DEFAULT_RETURN_PHRASE}". Pass \`back\` (e.g. "Sunday, August 9") to name the day.`;

    return text([
      `Away mode: **ON** until ${formatEastern(when.toISOString())} — it switches itself off then.`,
      'Live everywhere within 60s (flag cache TTL).',
      '',
      'First-contact customers will now receive:',
      '',
      buildAwayAck(phrase).text,
      warn,
    ].join('\n'));
  }

  return text(`Unknown action "${act}". Use: status | on | off | preview.`);
}

module.exports = [
  {
    name: 'away_mode',
    description:
      'Turn the customer-facing out-of-office acknowledgment on or off, or check whether it is on. '
      + 'While away mode is on, a customer contacting CS for the FIRST time gets one short email saying '
      + 'Jamie is out of town with limited internet, so they are not left in silence; the advisor still '
      + 'drafts a real reply that waits for review as normal. '
      + 'Use when Jamie says he is going away / travelling / off-grid, asks to turn on (or off) his out of '
      + 'office, or asks whether it is currently on. '
      + 'Enabling REQUIRES `until` (when it switches itself off) — pass `back` too so the email can name '
      + 'the day he returns. Call with action "preview" to show the email without changing anything.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          description: 'One of: "status" (default), "on", "off", "preview".',
        },
        until: {
          type: 'string',
          description:
            'Required for action "on". When away mode switches itself back off, in Eastern Time: '
            + '"YYYY-MM-DD HH:mm" (e.g. "2026-08-10 08:00") or a full ISO string. Set it to the morning '
            + 'Jamie is back at his desk.',
        },
        back: {
          type: 'string',
          description:
            'Customer-facing return phrase, rendered as "out of town until <back>". e.g. "Sunday, August 9". '
            + 'Keep it at or slightly before `until` so the promise is met before the email stops going out.',
        },
      },
    },
    handler: handleAwayMode,
  },
];
