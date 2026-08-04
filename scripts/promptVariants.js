/**
 * Prompt variants for A/B evaluation.
 *
 * Each variant is a pure string transform over the static system prompt, so a
 * variant is defined by exactly what it REMOVES. That keeps every arm honest:
 * the difference between control and treatment is visible as a diff, not as
 * two independently-written prompts whose gap could be anything.
 *
 * Single-variable first. A blanket "delete all 11 scenario blocks" would fail
 * for reasons unrelated to the thesis, because several of them carry real
 * policy rather than a behavioural override — the shaping-expectations
 * template, the free_order classification, the defect handling, and the
 * discount-code mechanics (action_type wiring and the [CODE] placeholder) are
 * all load-bearing. Deleting those would produce a bad result that says
 * nothing about whether carve-outs are the problem.
 */

/** Cut a `### `-delimited block by its heading, up to the next ### or ##. */
function cutBlock(prompt, headingStartsWith) {
  const lines = prompt.split('\n');
  const start = lines.findIndex(l => l.startsWith('### ') && l.includes(headingStartsWith));
  if (start === -1) return { prompt, removed: 0 };
  let end = start + 1;
  while (end < lines.length && !/^#{2,3}\s/.test(lines[end])) end++;
  const removed = lines.slice(start, end).join('\n').length;
  return { prompt: [...lines.slice(0, start), ...lines.slice(end)].join('\n'), removed };
}

function cutAll(prompt, headings) {
  let out = prompt, removed = 0;
  for (const h of headings) {
    const r = cutBlock(out, h);
    out = r.prompt; removed += r.removed;
  }
  return { prompt: out, removed };
}

// The behavioural overrides — rules that dictate a response SHAPE and
// duplicate or contradict the general decision rules. These are the fossil
// layer. Everything else in SPECIFIC SCENARIO RULES stays.
const OVERRIDE_BLOCKS = [
  'Large order (5+ items)',                 // forced a needless confirm on 2949
  'Customer says "too big" or "too loose"', // duplicates Size Guidance
  '"Too loose" on a bra/bikini top',        // duplicates Size Guidance
  'Customer says "return" or "refund"',     // duplicates the Refunds decision rules
  'Customer follows up on a missing exchange',
];

const VARIANTS = {
  // Control: the shipped prompt, untouched.
  control: p => p,

  // Narrowest possible test of the 2949 failure. If deleting exactly one block
  // flips that ticket, the causal claim is clean and cost about a dollar.
  'no-large-order': p => cutBlock(p, 'Large order (5+ items)').prompt,

  // The wider fossil-layer cut, still leaving every policy-bearing scenario.
  'no-overrides': p => cutAll(p, OVERRIDE_BLOCKS).prompt,
};

function apply(name) {
  const fn = VARIANTS[name];
  if (!fn) throw new Error(`unknown variant "${name}" (have: ${Object.keys(VARIANTS).join(', ')})`);
  return fn;
}

module.exports = { VARIANTS, apply, cutBlock, cutAll, OVERRIDE_BLOCKS };
