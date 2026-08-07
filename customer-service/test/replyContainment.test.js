const { test, describe } = require('node:test');
const assert = require('node:assert');

const { sliceBetweenAnchors, parseVerdict } = require('../lib/replyContainment');

// The two real leaks this guard was built from, trimmed to their structure.
// They matter because they point OPPOSITE ways: in 2959 the reply to keep is
// the first half, in 3131 it is the second. Any positional rule passes one and
// fails the other, which is why the slicing is anchor-driven.
const LEAK_TRAILING_NARRATION = `Hi,

The size 9 was too small? The size 10 will have 1" more fabric around the waist than the 9, and the size 11 will have 2" more. Which one sounds like a better fit?



Wait, I need to reconsider. The customer already has a size 10 on this order. The reply is fine.`;

const LEAK_TWO_ATTEMPTS = `Hi Sarah,

That's so kind, thank you.

On the underwear, no problem, I'll swap those two AJs for the Charlie.

Talk soon,

Jamie Alexander, RUBIES Founder

Wait, I need to reconsider. The swim piece is still pending a decision, so the overall status is needs_info. Let me rewrite this properly.

Hi Sarah,

That's so kind, thank you.

On the underwear, no problem, the Charlie in Black and Pink is what we'll do.

Talk soon,

Jamie Alexander, RUBIES Founder`;

describe('sliceBetweenAnchors', () => {
  test('keeps the FIRST half when the narration trails the email', () => {
    const res = sliceBetweenAnchors(
      LEAK_TRAILING_NARRATION,
      'Hi,\n\nThe size 9 was too small? The size',
      'Which one sounds like a better fit?'
    );
    assert.ok(!res.error, res.error);
    assert.ok(res.text.startsWith('Hi,'));
    assert.ok(res.text.endsWith('better fit?'));
    assert.ok(!res.text.includes('I need to reconsider'));
  });

  test('keeps the SECOND attempt when the advisor restarts the email', () => {
    const res = sliceBetweenAnchors(
      LEAK_TWO_ATTEMPTS,
      "Hi Sarah,\n\nThat's so kind, thank you.\n\nOn",
      'Jamie Alexander, RUBIES Founder'
    );
    assert.ok(!res.error, res.error);
    assert.ok(!res.text.includes('I need to reconsider'), 'narration must not survive');
    assert.ok(res.text.includes("the Charlie in Black and Pink is what we'll do"), 'must keep the settled wording');
    assert.ok(!res.text.includes("I'll swap those two AJs"), 'must drop the discarded attempt');
  });

  // The load-bearing detail. The start anchor matches BOTH attempts; searching
  // forwards would splice attempt one onto attempt two and carry the narration
  // between them straight through the guard.
  test('searches backwards from the end anchor, not forwards from the start', () => {
    const res = sliceBetweenAnchors(
      LEAK_TWO_ATTEMPTS,
      "Hi Sarah,\n\nThat's so kind, thank you.\n\nOn",
      'Jamie Alexander, RUBIES Founder'
    );
    const firstOccurrence = LEAK_TWO_ATTEMPTS.indexOf("Hi Sarah,\n\nThat's so kind");
    const keptOccurrence = LEAK_TWO_ATTEMPTS.lastIndexOf(res.text);
    assert.ok(keptOccurrence > firstOccurrence, 'must anchor on the later attempt');
  });

  test('output is always a verbatim contiguous substring of the input', () => {
    const res = sliceBetweenAnchors(
      LEAK_TWO_ATTEMPTS,
      "Hi Sarah,\n\nThat's so kind, thank you.\n\nOn",
      'Jamie Alexander, RUBIES Founder'
    );
    assert.ok(LEAK_TWO_ATTEMPTS.includes(res.text), 'the guard must never author text');
  });

  describe('fails closed', () => {
    test('when the end anchor was not copied verbatim', () => {
      const res = sliceBetweenAnchors(LEAK_TWO_ATTEMPTS, 'Hi Sarah,', 'Jamie Alexander, RUBIES founder');
      assert.match(res.error, /end anchor not found/);
    });

    test('when the start anchor was not copied verbatim', () => {
      const res = sliceBetweenAnchors(LEAK_TWO_ATTEMPTS, 'Hello Sarah,', 'Jamie Alexander, RUBIES Founder');
      assert.match(res.error, /start anchor not found/);
    });

    test('when the start anchor only appears AFTER the end anchor', () => {
      const text = 'Talk soon,\n\nJamie Alexander, RUBIES Founder\n\nHi Sarah, this trails the sign-off entirely.';
      const res = sliceBetweenAnchors(text, 'Hi Sarah,', 'Talk soon,');
      assert.match(res.error, /start anchor not found/);
    });

    test('when either anchor is empty', () => {
      assert.match(sliceBetweenAnchors(LEAK_TWO_ATTEMPTS, '', 'Founder').error, /empty anchor/);
      assert.match(sliceBetweenAnchors(LEAK_TWO_ATTEMPTS, 'Hi Sarah,', '').error, /empty anchor/);
    });

    test('when the slice is too short to be a real email', () => {
      const res = sliceBetweenAnchors(LEAK_TWO_ATTEMPTS, 'Talk soon,', 'Talk soon,');
      assert.match(res.error, /implausibly short/);
    });

    // A "leak" that would remove almost nothing is a misfire, not a fix, and
    // cutting on it risks trimming a legitimate sign-off for no benefit.
    test('when there is nothing substantial to remove', () => {
      const clean = `Hi Sarah,\n\nThat is all sorted, the exchange is on its way.\n\nTalk soon,\n\nJamie Alexander, RUBIES Founder`;
      const res = sliceBetweenAnchors(clean, 'Hi Sarah,', 'Jamie Alexander, RUBIES Founder');
      assert.match(res.error, /nothing substantial/);
    });
  });

  // The three real false positives from the corpus replay. Each is a clean
  // email whose opening paragraph the model mistook for a working note; each
  // would have reached a customer with its greeting and half its content gone.
  describe('refuses a front cut that leaves something which is not an email', () => {
    test('draft 495 — keeps the refund confirmation the model wanted to drop', () => {
      const clean = `Hi Ashley,

I've processed the refund for the size 14 AJs and Ruby. For future reference, if the leg openings feel tight but the waist fits, the Sassy and Cheeky have larger leg openings.

Since both the 16s and 14s are being donated, please wash them and drop them off when you get a chance.

Take care,
Jamie Alexander, RUBIES Founder`;
      const res = sliceBetweenAnchors(clean, 'Since both the 16s and 14s are being', 'Jamie Alexander, RUBIES Founder');
      assert.match(res.error, /does not open like an email/);
    });

    test('draft 2128 — the opening paragraph is addressed to the customer', () => {
      const clean = `I want to make sure I get the right product name first, since I don't have a "Sally" in our lineup. We have the Sassy, which I think might be what you mean.

On the sizing: our underwear follows standard US womens sizing, nothing unique to RUBIES. I'd go with what the chart recommends for your measurement.

Talk soon,
Jamie Alexander, RUBIES Founder`;
      const res = sliceBetweenAnchors(clean, 'On the sizing: our underwear follows', 'Jamie Alexander, RUBIES Founder');
      assert.match(res.error, /does not open like an email/);
    });

    test('a non-English greeting still counts as an email opening', () => {
      const leak = `Le Charlie en taille L est disponible en noir et en rose, stock verifie.

Bonjour,

Le Charlie en taille L est bien disponible dans les deux couleurs, donc pas de souci pour votre commande.

Talk soon,
Jamie Alexander, RUBIES Founder`;
      const res = sliceBetweenAnchors(leak, 'Bonjour,', 'Jamie Alexander, RUBIES Founder');
      assert.ok(!res.error, res.error);
      assert.ok(res.text.startsWith('Bonjour,'));
      assert.ok(!res.text.includes('stock verifie'));
    });

    // Trailing removal takes nothing off the front, so the opening is whatever
    // the advisor wrote and the greeting check must not apply.
    test('a trailing cut is exempt from the greeting check', () => {
      const leak = `Thanks so much for letting me know, that is all sorted on my end now and nothing further is needed from you.

Wait, I need to reconsider whether that covers the second order. It does. The reply is fine.`;
      const res = sliceBetweenAnchors(leak, 'Thanks so much for letting me know', 'nothing further is needed from you.');
      assert.ok(!res.error, res.error);
      assert.ok(!res.text.includes('I need to reconsider'));
    });
  });
});

describe('parseVerdict', () => {
  test('reads a bare JSON object', () => {
    assert.deepEqual(parseVerdict('{"leak":false,"reason":"","start":"","end":""}').leak, false);
  });

  test('reads JSON inside a fenced block', () => {
    assert.equal(parseVerdict('```json\n{"leak":true,"reason":"two drafts"}\n```').reason, 'two drafts');
  });

  test('reads JSON with prose around it', () => {
    assert.equal(parseVerdict('Here is my answer:\n{"leak":true,"reason":"x"}\nHope that helps.').leak, true);
  });

  test('returns null on unparseable output rather than guessing', () => {
    assert.equal(parseVerdict('I think there might be a leak here'), null);
    assert.equal(parseVerdict('{"leak": tru'), null);
    assert.equal(parseVerdict(''), null);
  });
});
