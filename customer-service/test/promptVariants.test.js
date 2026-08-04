const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { VARIANTS, cutBlock, cutAll, OVERRIDE_BLOCKS } = require('../../scripts/promptVariants');

// The real prompt body, so the tests fail if a heading is renamed upstream and
// a variant silently starts cutting nothing.
const PROMPT = fs.readFileSync(path.resolve(__dirname, '../lib/aiAdvisor.js'), 'utf8')
  .split('\n').slice(840, 1419).join('\n');

describe('cutBlock', () => {
  it('removes the named block and stops at the next heading', () => {
    const { prompt, removed } = cutBlock(PROMPT, 'Large order (5+ items)');
    assert.ok(removed > 0, 'heading not found — has it been renamed?');
    assert.doesNotMatch(prompt, /Large order \(5\+ items\)/);
    assert.match(prompt, /Scenario: Defective product/, 'must not swallow the next block');
    assert.match(prompt, /Scenario: Customer follows up on a missing exchange/, 'must not swallow the previous block');
  });

  it('is a no-op on an unknown heading', () => {
    const { prompt, removed } = cutBlock(PROMPT, 'Scenario: Nonexistent');
    assert.equal(removed, 0);
    assert.equal(prompt, PROMPT);
  });
});

describe('variants', () => {
  it('control is the identity — the shipped prompt, untouched', () => {
    assert.equal(VARIANTS.control(PROMPT), PROMPT);
  });

  it('no-large-order cuts exactly one block', () => {
    const out = VARIANTS['no-large-order'](PROMPT);
    assert.ok(PROMPT.length - out.length > 300);
    assert.doesNotMatch(out, /Large order \(5\+ items\)/);
    // every other scenario block survives
    const before = (PROMPT.match(/^### Scenario:/gm) || []).length;
    const after = (out.match(/^### Scenario:/gm) || []).length;
    assert.equal(after, before - 1);
  });

  it('no-overrides keeps every policy-bearing scenario', () => {
    // A blanket delete of all 11 blocks would fail for reasons unrelated to
    // the thesis: several carry real policy, not a behavioural override.
    const out = VARIANTS['no-overrides'](PROMPT);
    assert.match(out, /reshape the front area/, 'shaping-expectations template is Jamie\'s own copy');
    assert.match(out, /\[CODE\]/, 'discount-code mechanics drive an action_type');
    assert.match(out, /free_order/, 'free_order classification is policy');
    assert.match(out, /Scenario: Defective product/);
    assert.match(out, /Pre-purchase concern/);
  });

  it('every override block named actually exists in the prompt', () => {
    for (const h of OVERRIDE_BLOCKS) {
      assert.ok(cutBlock(PROMPT, h).removed > 0, `"${h}" no longer matches any heading`);
    }
  });

  it('rejects an unknown variant name rather than silently running control', () => {
    assert.throws(() => require('../../scripts/promptVariants').apply('nope'), /unknown variant/);
  });
});

describe('prompt transform hook', () => {
  it('is inert unless a caller sets it', () => {
    // Production must never be flippable into an experimental prompt. The hook
    // has no env-var path by design; an eval script has to set it explicitly.
    const src = fs.readFileSync(path.resolve(__dirname, '../lib/aiAdvisor.js'), 'utf8');
    assert.match(src, /let _promptTransform = null;/);
    assert.doesNotMatch(src, /process\.env\.[A-Z_]*PROMPT_VARIANT/);
  });
});
