const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { factSimilarity, normalizeFact, FACT_DUPE_THRESHOLD } = require('../../lib/judgeDaily');

const dupe = (a, b) => factSimilarity(a, b) >= FACT_DUPE_THRESHOLD;

describe('factSimilarity', () => {
  it('catches most of the rephrasings that filled the pending queue', () => {
    // Real pending rows, 2026-07-11 through 07-14. Substring matching passed
    // every one of these as "new", so the judge queued nine variants of one
    // fact and the queue stopped being reviewed.
    //
    // This asserts MOST, not all, and that is deliberate. Two of these share
    // almost no vocabulary despite meaning the same thing, and no word-overlap
    // threshold separates them from genuinely distinct facts. Catching most is
    // the win; the safety property is the next test.
    const variants = [
      'RUBIES returns are donated rather than shipped back; customers are asked to donate the returned item locally or to a partner LGBTQ+ organization.',
      'RUBIES has moved to a model where all returns are donated rather than shipped back, and customers can donate the item locally or request info for a partner.',
      'RUBIES does not require customers to physically return items; all returns are donated to organizations running gender-affirming programs.',
      'RUBIES has moved to a model where returned items are donated to organizations running gender-affirming clothing programs rather than shipped back.',
    ];
    let caught = 0, pairs = 0;
    for (let i = 0; i < variants.length; i++) {
      for (let j = i + 1; j < variants.length; j++) {
        pairs++;
        if (dupe(variants[i], variants[j])) caught++;
      }
    }
    assert.ok(caught >= 4, `expected at least 4 of ${pairs} duplicate pairs caught, got ${caught}`);
  });

  it('NEVER merges two distinct facts — the safety property', () => {
    // Wrongly merging loses a real fact permanently; leaving a duplicate only
    // costs the reviewer a second. The threshold is set for this direction.
    const distinct = [
      'PayPal is available as an alternative payment method at checkout.',
      'OnTrac requires the seller to approve address change requests directly, so RUBIES must contact OnTrac to authorize any customer address correction.',
      'New colorways are constrained by supplier minimum order quantities.',
      'Tracking links typically do not display the exact delivery address.',
      'For address-correction issues, customers can update delivery info through the OnTrac tracking link within a limited window.',
      'RUBIES returns are donated rather than shipped back to the warehouse.',
    ];
    for (let i = 0; i < distinct.length; i++) {
      for (let j = i + 1; j < distinct.length; j++) {
        assert.ok(!dupe(distinct[i], distinct[j]),
          `falsely merged:\n  ${distinct[i]}\n  ${distinct[j]}\n  score ${factSimilarity(distinct[i], distinct[j]).toFixed(2)}`);
      }
    }
  });

  it('keeps genuinely distinct facts apart', () => {
    const distinct = [
      'PayPal is available as an alternative payment method at checkout.',
      'OnTrac requires the seller to approve address change requests directly, so RUBIES must contact OnTrac to authorize any customer address correction.',
      'New colorways are constrained by supplier minimum order quantities.',
      'Tracking links typically do not display the exact delivery address.',
    ];
    for (let i = 0; i < distinct.length; i++) {
      for (let j = i + 1; j < distinct.length; j++) {
        assert.ok(!dupe(distinct[i], distinct[j]),
          `should stay separate:\n  ${distinct[i]}\n  ${distinct[j]}`);
      }
    }
  });

  it('does not collapse two facts that merely share a topic', () => {
    // Both about OnTrac, but one is a policy and one is a UI detail. Losing
    // the second because the first arrived earlier would be a real loss.
    assert.ok(!dupe(
      'OnTrac requires the seller to approve address change requests directly.',
      'For address-correction issues, customers can update delivery info through the OnTrac tracking link within a limited window.',
    ));
  });

  it('is symmetric and self-identical', () => {
    const a = 'PayPal is available as an alternative payment method at checkout.';
    const b = 'Customers can pay by PayPal at checkout as an alternative method.';
    assert.equal(factSimilarity(a, b), factSimilarity(b, a));
    assert.equal(factSimilarity(a, a), 1);
  });

  it('handles empty and junk input without throwing', () => {
    assert.equal(factSimilarity('', 'anything at all here'), 0);
    assert.equal(factSimilarity('!!! ???', 'other'), 0);
  });
});

describe('normalizeFact', () => {
  it('strips punctuation and collapses whitespace', () => {
    assert.equal(normalizeFact('  RUBIES: returns —  donated!  '), 'rubies returns donated');
  });
});
