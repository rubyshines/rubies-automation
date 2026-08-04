#!/usr/bin/env node

/**
 * Extract every instruction in the advisor prompt that dictates what the
 * advisor SAYS, for founder ruling.
 *
 * Why this exists: tolerance-review item #8. Jamie flagged "I'll get you into
 * a size that works" as superfluous — but the advisor didn't invent it, the
 * prompt instructs that exact opener verbatim. It obeyed and he disliked the
 * result. The prompt accreted over five months, mostly written in response to
 * individual incidents, and nobody has ever asked him whether he agrees with
 * all of it.
 *
 * A mandate he disagrees with is worse than no rule: it reliably produces
 * output he then edits. That is invisible to every metric we have, because the
 * draft is "following the prompt correctly".
 *
 * Prescriptions are ranked above prohibitions deliberately. A prohibition he
 * disagrees with only makes the advisor unnecessarily narrow; a prescription
 * he disagrees with actively generates text he has to delete.
 *
 * Usage: node scripts/extractSayRules.js [--out=eval/say-rules.json]
 */

const path = require('path');
const fs = require('fs');

const ADVISOR = path.resolve(__dirname, '../customer-service/lib/aiAdvisor.js');
const PROMPT_FROM = 840;   // start of staticPart
const PROMPT_TO = 1419;    // end, before Output Format note

const arg = (n, d) => (process.argv.find(x => x.startsWith(`--${n}=`)) || `=${d}`).split('=')[1];

// A line is telling the advisor to USE this wording.
const PRESCRIBE = [
  /verbatim shape/i, /\bshape:/i, /open with/i, /use exactly this phrase/i,
  /always add/i, /near-verbatim/i, /say exactly/i, /word-for-word/i,
  /use it verbatim/i, /exactly these/i, /use the .*template/i, /copy .*verbatim/i,
  /note:\s*"/i, /verbatim/i,
];
// Negation anywhere in the clause flips it: the phrase is an example of what
// NOT to write, not a mandate.
const PROHIBIT = [
  /\bNEVER\b/, /\bDO NOT\b/, /\bdon'?t\b/i, /\bno\s+(preamble|meta-talk|second)/i,
  /\bavoid\b/i, /\breserved for\b/i, /\bnot\b\s+["']/i,
];

function sectionOf(lines, i) {
  for (let j = i; j >= 0; j--) {
    const m = lines[j].match(/^#{2,3}\s+(.+)$/);
    if (m) return m[1].replace(/\s*\(.*$/, '').trim();
  }
  return 'unknown';
}

// Internal mechanics, not customer wording — the audit is about what lands in
// the email, not how the structured block is filled in.
const MECHANICS = /action_type|set status|operator_action_summary|message_type|structured|items\[\]|CONFIRMED|AWAITING|call [a-z_]+\(|\btool\b/i;

// The line is quoting the CUSTOMER, not instructing us. Those look like
// triggers ("Customer says ...", "Triggers: ...") and their quotes are inputs.
const CUSTOMER_SIDE = /customer says|customer message|triggers?:|they said|inbound is|e\.g\. ["']?(help me|what did I)/i;

/**
 * A quoted string is a candidate mandate only if it reads like agent prose:
 * a real clause, sentence-cased, not a mid-sentence fragment the regex sliced
 * out of the surrounding instruction.
 */
function isAgentPhrase(p) {
  const t = p.trim();
  if (t.length < 18) return false;
  if (!/^[A-Z]/.test(t)) return false;             // fragments start lowercase
  if (/^(Forwarded|From:|Pre-order|CONVERSATION|LATEST)/.test(t)) return false;  // markers
  if (!/\s/.test(t)) return false;
  return /[a-z]/.test(t);
}

function extract(lines) {
  const out = [];
  lines.forEach((line, i) => {
    if (MECHANICS.test(line) || CUSTOMER_SIDE.test(line)) return;
    const quotes = (line.match(/"[^"]{12,}"/g) || [])
      .map(q => q.slice(1, -1))
      .filter(isAgentPhrase);
    const prescribes = PRESCRIBE.some(re => re.test(line));
    if (!quotes.length) return;
    if (!prescribes && !/["']/.test(line)) return;

    const prohibits = PROHIBIT.some(re => re.test(line));
    // A line can do both ("Open with X, never Y"). Prescription wins when an
    // explicit template marker is present, since that is the mandated part.
    const kind = prescribes && !/^\s*-?\s*(NEVER|DO NOT)/i.test(line.trim())
      ? 'prescribe'
      : (prohibits ? 'prohibit' : 'prescribe');

    out.push({
      line_no: PROMPT_FROM + i + 1,
      section: sectionOf(lines, i),
      kind,
      instruction: line.trim().replace(/^-\s*/, '').slice(0, 700),
      phrases: quotes.slice(0, 4),
    });
  });
  return out;
}

function main() {
  const src = fs.readFileSync(ADVISOR, 'utf8').split('\n').slice(PROMPT_FROM, PROMPT_TO);
  const rules = extract(src);
  const prescribe = rules.filter(r => r.kind === 'prescribe');
  const prohibit = rules.filter(r => r.kind === 'prohibit');

  const out = path.resolve(__dirname, '..', arg('out', 'eval/say-rules.json'));
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify({ prescribe, prohibit }, null, 1));

  console.log(`${rules.length} wording rules found — ${prescribe.length} prescribe, ${prohibit.length} prohibit`);
  const bySec = {};
  for (const r of prescribe) bySec[r.section] = (bySec[r.section] || 0) + 1;
  console.log('\nprescriptions by section:');
  Object.entries(bySec).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log(`  ${k.slice(0, 44).padEnd(46)}${v}`));
  console.log(`\nwritten to ${out}`);
}

if (require.main === module) main();

module.exports = { extract, sectionOf };
