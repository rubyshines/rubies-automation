/**
 * The LEAN prompt — arm B of the 2x2.
 *
 * Thesis under test: the advisor's two measured defects (asks when the
 * customer already gave it everything; bolts unrequested sentences onto a
 * correct action) are a COMPLIANCE failure, not a content failure. Every one
 * of Jamie's 11 tolerance flags was already an explicit rule in the prompt,
 * seven of them marked CRITICAL. Writing better rules is what the last ten
 * weeks were, and the aggregate has not moved.
 *
 * So the lean arm stops DESCRIBING the shape of a good reply and SHOWS it:
 * the register lectures come out, 78 of Jamie's own pre-March replies go in.
 * Two independent findings support the mechanism — positive verbatim
 * templates stick where negative rules drift, and an active tone sample beat
 * a written rule outright in the 07-22 sorry drift.
 *
 * What is deliberately NOT touched: the anti-hallucination rules, the
 * action_type taxonomy and its gating, tense/structured-field agreement, the
 * money and size math, donation gating, safety, and the mechanical style bans
 * (em-dash, emoji, profile name, signature block). None of those describe a
 * SHAPE; they are correctness, and an exemplar cannot teach them reliably.
 *
 * The transform is mechanical and asserts on every anchor it expects to find,
 * so a future prompt edit that moves a heading fails loudly here instead of
 * silently cutting the wrong block. Build it as a diff, never as a
 * hand-rewritten second prompt — otherwise the gap between the arms could be
 * anything.
 */

const path = require('path');
const { select } = require('../scripts/publishExemplarSheet');

const CANDIDATES = path.resolve(__dirname, 'exemplar-candidates.json');

// ---------------------------------------------------------------------------
// Exemplar block
// ---------------------------------------------------------------------------

// The mined replies are whitespace-flattened, so Jamie's greeting line and his
// sign-off run into the body ("Hi, Just to confirm..."). Left in, they would
// teach the exact run-on greeting the format rule forbids, and they would
// bloat 78 samples with 78 copies of a signature the prompt already mandates
// verbatim. Strip both — same convention the tone samples use, and the framing
// text below says so explicitly.
const GREETING = /^(hi|hey|hello)(\s+[A-Z][\w'-]*)?\s*[,!.]?\s*/i;
const SIGNOFF = /\s*(take care|talk soon|thanks|thank you|best|cheers|regards)[,.]?\s*(jamie(\s+alexander)?)?[,.]?\s*(rubies\s+founder)?[,.]?\s*$/i;

function stripEnvelope(reply) {
  let body = String(reply || '').trim();
  body = body.replace(GREETING, '');
  // Two passes: "Take care, Jamie Alexander, RUBIES Founder" strips as one
  // match, but "...refund. Thanks, Jamie" leaves a bare "Jamie" behind on
  // corpora where the name and valediction were split.
  body = body.replace(SIGNOFF, '').replace(/\s*,?\s*jamie(\s+alexander)?\s*,?\s*(rubies\s+founder)?\s*[,.]?\s*$/i, '');
  return body.trim();
}

// Enough of the inbound to show WHY he answered the way he did, without
// carrying whole bot-intake dumps into the prompt. The decision is almost
// always legible in the first couple of sentences.
const CUSTOMER_CAP = 260;

function buildExemplarBlock(rows) {
  const body = rows.map((x) => {
    const said = x.customer.replace(/\s+/g, ' ').trim();
    const wrote = stripEnvelope(x.jamie);
    return `[${x.situation}${x.reply_index >= 2 ? ', reply 2+' : ''}]\nCustomer: ${said.length > CUSTOMER_CAP ? `${said.slice(0, CUSTOMER_CAP)}…` : said}\nJamie: ${wrote}`;
  }).join('\n\n');

  return `
## How Jamie Replies
These are ${rows.length} real replies Jamie wrote himself, with the customer's message above each one. They are the standard. Where a rule below tells you WHAT is true or WHAT to set, follow the rule; how much to say, whether to act or ask, and where to stop are shown here.

Read them for the decision as much as the wording. Notice how often he just does the thing the customer asked for instead of confirming it back, that he answers the question that was asked and nothing adjacent, and how short a complete reply is.

Each sample is the BODY ONLY — the greeting line and the sign-off have been stripped. They show you what to say, never how a reply begins or ends. Your reply always opens with the greeting line and always ends with the valediction plus the two-line signature block, no matter how short the body is.

${body}
`;
}

function exemplarBlock() {
  const candidates = require(CANDIDATES);
  return buildExemplarBlock(select(candidates, 8));
}

// ---------------------------------------------------------------------------
// The compressed register core
// ---------------------------------------------------------------------------

// What survives of RESPONSE LENGTH & REGISTER. Every line here is a founder
// ruling an exemplar cannot be trusted to carry on its own: either it fires on
// a trigger the 78 samples happen not to cover, or it is a prohibition, and a
// prohibition has no positive example to learn from. The prose that merely
// described good writing is gone — that is what the exemplars are for.
const REGISTER_CORE = `## RESPONSE REGISTER
- **ONE MOVE PER MESSAGE (GOVERNING RULE).** For each issue the customer raised, pick the single most useful move — act, ask, or explain — and make only that move, plus its required attachments (donation info with a created order, the one diagnostic question with a refund grant, the invoice line with an upcharge exchange, the pre-committed recourse on a shipping problem). Everything else waits for the next email if the customer asks.
- **Explanations are a move with a trigger, not default furniture.** Explain only where a rule below says to. A plain fit complaint (too big/small/tight/loose) gets a size suggestion or one measurement question, never a lecture.
- ONE question per response. Almost never two.
- **Never restate what the customer already knows.** Don't recap their message, don't itemize the products and sizes they just named back at them, and don't repeat anything you said earlier in the thread. Recap a detail only when YOU chose it (a substitute, a size you recommended) or it changed from what they asked for.
- **Don't enumerate options they didn't ask about.** No colour lists, alternative products, or "it also comes in..." unless they asked or their choice is unavailable.
- **"Sorry" is reserved for problems RUBIES caused** — wrong item, defect, our delay, a ball we dropped. One short clause, then the fix. Fit, sizing and preference issues are nobody's fault and get zero apology words: open with the fix.
- **Validate a fair complaint before fixing it, but only about RUBIES' own failures.** Agree plainly in one clause, then the causal explanation and the fix. Never absorb blame that isn't ours. (Jamie, 2026-08-04: "I hear you loud and clear" is too strong, and "You are not the first to make this comment" claims knowledge you do not have.)
- **Third-party problems (customs, carriers, payment processors): go straight to the boundary, then the remedy.** (Jamie, 2026-08-04: do not open by naming the feeling — "That sounds frustrating" is cut. Stating the situation plainly and fixing it is the empathy.) Softeners like "unfortunately" are fine; "sorry" is not.
- **Say it plainly, no meta-talk.** Open with the question itself. Never preface it by narrating your own carefulness ("I want to make sure I get this right", "I'd hate to give you wrong info").
- **Bad news is a snag with options; refusals always carry an alternative.** Deliver stock/timing problems as "The only snag is..." plus 2-3 concrete options. The option menu belongs to stock/timing problems only — never bolt one onto a reply that has no snag in it. Never a bare "no".
- **Mirror the customer's energy on relationship beats**, and keep transactional sentences (refund, logistics) flat regardless.
- **Acknowledge a personal story once, and only the fact.** Never evaluate the person: no praise, reassurance or comment on how they're handling their life ("you're doing great", "sounds like you've got a lot on your plate"). You can't know, and it reads as performed empathy.
- **Donation/returns boilerplate appears ONCE per conversation**, and refers to the goods generically ("the item(s)"), never re-itemized and never a bare size as a noun.
`;

// ---------------------------------------------------------------------------
// Writing-style surgery
// ---------------------------------------------------------------------------

// Bullet-level, because that section is half mechanical law and half register
// coaching. Anchors are the opening words of each top-level bullet. Anything
// unclassified is a loud failure, not a silent pass — if a prompt edit adds a
// bullet, this transform must not guess which pile it belongs in.
const STYLE_CUT = [
  'Match the customer\'s energy',
  '**Get to the point',
  '**The body contains only what moves things forward',
  '**Post-action closing',
  'When the customer says they emailed before',
  'For cancellations (confirmed',
  'When customers share personal stories',
  'When a customer compliments RUBIES',
  'When a defect is reported',
];

const STYLE_KEEP = [
  'NEVER use em-dashes',
  'NEVER say "absolutely"',
  'NEVER use emojis',
  'NEVER use the customer\'s Shopify profile name',
  'Default to they/them',
  'Signature: close the body',
  '**Advocacy P.S.',
  'When asking what didn\'t work',
  'For measurements on bottoms',
  'NEVER say "Shall I set that up?"',
  'NEVER narrate your own thinking',
  '**Tool calls precede customer-facing prose',
  'Open with "Hi," or "Hi [name],"',
  'Action tense and structured fields MUST agree',
  'If the customer writes in a language other than English',
  'When the situation is confusing',
];

/** Split a markdown bullet list into top-level bullets (continuation lines ride along). */
function bullets(lines) {
  const out = [];
  for (const l of lines) {
    if (/^- /.test(l) || out.length === 0) out.push([l]);
    else out[out.length - 1].push(l);
  }
  return out;
}

function leanWritingStyle(prompt) {
  const lines = prompt.split('\n');
  const start = lines.findIndex(l => l.startsWith('## Writing Style Rules'));
  if (start === -1) throw new Error('lean: "## Writing Style Rules" heading not found');
  let end = start + 1;
  while (end < lines.length && !/^#{2}\s/.test(lines[end]) && !/^\$\{toneSection\}/.test(lines[end])) end++;

  const kept = [lines[start]];
  for (const b of bullets(lines.slice(start + 1, end))) {
    const head = b[0].replace(/^- /, '');
    if (!/^- /.test(b[0])) { kept.push(...b); continue; }       // blank/continuation lines
    const cut = STYLE_CUT.some(a => head.startsWith(a));
    const keep = STYLE_KEEP.some(a => head.startsWith(a));
    if (cut === keep) throw new Error(`lean: unclassified writing-style bullet — ${head.slice(0, 70)}`);
    if (keep) kept.push(...b);
  }
  return [...lines.slice(0, start), ...kept, ...lines.slice(end)].join('\n');
}

// ---------------------------------------------------------------------------
// Section-level cuts
// ---------------------------------------------------------------------------

/** Replace a `## `-delimited section (heading through the line before the next `## `). */
function replaceSection(prompt, headingStartsWith, replacement) {
  const lines = prompt.split('\n');
  const start = lines.findIndex(l => l.startsWith('## ') && l.includes(headingStartsWith));
  if (start === -1) throw new Error(`lean: section not found — ${headingStartsWith}`);
  let end = start + 1;
  while (end < lines.length && !/^#{2}\s/.test(lines[end])) end++;
  return [...lines.slice(0, start), ...(replacement ? replacement.split('\n') : []), ...lines.slice(end)].join('\n');
}

// The five behavioural overrides: rules that dictate a response SHAPE and
// duplicate or contradict the general decision rules. Deleting them alone did
// NOT fix act-vs-ask (control 20/63 vs 24/63 over three runs), so they are not
// the cure — but the 2949 result showed the large-order block causing a real
// failure, and every one of them is shape coaching the exemplars now carry. They
// come out as part of the bundle, not as a thesis of their own.
const { cutAll, OVERRIDE_BLOCKS } = require('../scripts/promptVariants');

function leanTransform(prompt) {
  let p = prompt;

  // 1. Register lectures → the compressed core of founder rulings.
  p = replaceSection(p, 'RESPONSE LENGTH & REGISTER', REGISTER_CORE);

  // 2. Writing Style: keep the mechanical and safety law, drop the coaching.
  p = leanWritingStyle(p);

  // 3. The behavioural scenario overrides.
  const before = p.length;
  p = cutAll(p, OVERRIDE_BLOCKS).prompt;
  if (p.length === before) throw new Error('lean: no override blocks matched');

  // 4. Tone samples → the 78 paired exemplars. The two example sets are not
  //    additive: the tone block's "use Jamie's EXACT phrases" framing is what
  //    beat a written rule in the 07-22 sorry drift, and running two corpora
  //    with different framings rebuilds exactly that contradiction. The
  //    exemplars strictly dominate — same voice, from-scratch pre-advisor
  //    writing, and each one carries the customer message that produced it, so
  //    they teach the act-vs-ask decision the body-only samples cannot.
  p = replaceSection(p, "Jamie's Actual Writing", exemplarBlock());

  return p;
}

module.exports = { leanTransform, exemplarBlock, buildExemplarBlock, stripEnvelope, REGISTER_CORE };
