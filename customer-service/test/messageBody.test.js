const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const {
  plainTextBeforeQuote,
  decodeEntities,
  htmlVisibleText,
  normalizeForCompare,
  linesMissingFromHtml,
  chooseBody,
  pickRichestBody,
} = require('../dashboard/public/messageBody');

const PUBLIC_DIR = path.join(__dirname, '..', 'dashboard', 'public');

// ---------------------------------------------------------------------------
// plainTextBeforeQuote — the cut that decides how much plain text we compare.
// Cut too early and real content looks missing from the HTML (false fallback);
// cut too late and the quoted chain looks missing (false fallback again).
// ---------------------------------------------------------------------------

describe('plainTextBeforeQuote', () => {
  it('returns the whole text when there is no quoted reply', () => {
    assert.equal(plainTextBeforeQuote('Just one line'), 'Just one line');
  });

  it('is empty for empty/nullish input', () => {
    assert.equal(plainTextBeforeQuote(''), '');
    assert.equal(plainTextBeforeQuote(null), '');
    assert.equal(plainTextBeforeQuote(undefined), '');
  });

  it('cuts at a Gmail / Apple Mail "On ... wrote:" header', () => {
    const text = 'My reply\n\nOn Wed, Aug 5, 2026 at 5:19 AM RUBIES Customer Care <care@rubyshines.com> wrote:\n> old stuff';
    assert.equal(plainTextBeforeQuote(text), 'My reply');
  });

  it('cuts at an Outlook "From: ... Sent:" header', () => {
    const text = 'My reply\n\nFrom: RUBIES Customer Care\nSent: Wednesday, August 5, 2026\nTo: me';
    assert.equal(plainTextBeforeQuote(text), 'My reply');
  });

  it('cuts at Original Message / Forwarded message / Begin forwarded message', () => {
    assert.equal(plainTextBeforeQuote('Reply\n\n-----Original Message-----\nold'), 'Reply');
    assert.equal(plainTextBeforeQuote('Reply\n\n---------- Forwarded message ---------\nold'), 'Reply');
    assert.equal(plainTextBeforeQuote('Reply\n\nBegin forwarded message:\nold'), 'Reply');
  });

  it('cuts at the EARLIEST marker when several are present', () => {
    const text = 'Reply\n\nOn Mon, Jan 1, 2026 at 9:00 AM Someone Longenough <a@b.com> wrote:\nquoted\n\n-----Original Message-----\nolder';
    assert.equal(plainTextBeforeQuote(text), 'Reply');
  });

  it('yields empty string when the message opens with the quote header', () => {
    assert.equal(plainTextBeforeQuote('On Mon, Jan 1, 2026 at 9:00 AM Someone Here <a@b.com> wrote:\nquoted'), '');
  });

  it('does not cut on prose that merely starts with "On"', () => {
    const text = 'On the whole I like it, but the straps catch. Nothing else to add here.';
    assert.equal(plainTextBeforeQuote(text), text);
  });

  // Every marker below came out of the stored-corpus sweep: each one was
  // producing a false "the HTML lost content" verdict on real tickets, because
  // Gorgias's stripped_html drops these trailing blocks and the plain text keeps
  // them. See the corpus regression block at the bottom of this file.

  it('cuts at an Outlook header that says Date: instead of Sent:', () => {
    const text = 'Reply here\n\nFrom: RUBIES Customer Care <care@rubyshines.com>\nTo: "Evin"<evin@example.net>\nDate: Mon, 25 May 2026 19:28:24 -0400';
    assert.equal(plainTextBeforeQuote(text), 'Reply here');
  });

  it('cuts at a verb-less attribution line ending in <address>:', () => {
    // FairEmail: "May 14, 2026 10:30:25 PM RUBIES Customer Care <care@…>:"
    const text = 'Thanks a bunch,\nFen\nMay 14, 2026 10:30:25 PM RUBIES Customer Care <care@rubyshines.com>: \nquoted agent reply';
    assert.equal(plainTextBeforeQuote(text), 'Thanks a bunch,\nFen');
  });

  it('cuts at localized attribution lines (Norwegian, Hebrew) via the address marker', () => {
    const nb = 'Takk skal du ha!\nfre. 22. mai 2026 kl. 00:50 skrev RUBIES Customer Care < care@rubyshines.com>: (mailto:care@rubyshines.com)\nquoted';
    assert.equal(plainTextBeforeQuote(nb), 'Takk skal du ha!');
    const he = 'תודה רבה\n‫בתאריך יום ב׳, 1 ביוני 2026 ב-16:01 מאת ‪RUBIES Customer Care‬‏ <‪care@rubyshines.com‬‏>:‬\nquoted';
    assert.equal(plainTextBeforeQuote(he), 'תודה רבה');
  });

  it('cuts at localized "wrote:" verbs', () => {
    assert.equal(plainTextBeforeQuote('Danke!\n\nAm 5. August 2026 um 10:00 Uhr schrieb Jamie:\nzitat'), 'Danke!');
    assert.equal(plainTextBeforeQuote('Merci!\n\nOn 5 août 2026 à 10:00, Jamie a écrit :\ncitation'), 'Merci!');
  });

  it('cuts at the RFC signature delimiter', () => {
    assert.equal(plainTextBeforeQuote('My message here\n-- \nDani Vigour\n555-1234'), 'My message here');
  });

  it('cuts at mail-client sign-off boilerplate', () => {
    assert.equal(plainTextBeforeQuote('Please cancel it\nAlix\nSent from my T-Mobile 5G Device'), 'Please cancel it\nAlix');
    assert.equal(plainTextBeforeQuote('Please cancel it\nGet Outlook for Android'), 'Please cancel it');
    assert.equal(plainTextBeforeQuote('Please cancel it\nYahoo Mail: Search, Organize, Conquer'), 'Please cancel it');
  });

  it('does not treat an address the customer typed into the body as a quote header', () => {
    const text = 'Please ship to 345 E Congress St, APT 1632, Tucson AZ 85701 instead.';
    assert.equal(plainTextBeforeQuote(text), text);
  });
});

// ---------------------------------------------------------------------------
// Entity decoding + visible-text extraction
// ---------------------------------------------------------------------------

describe('decodeEntities', () => {
  it('decodes the entities Gorgias actually emits', () => {
    assert.equal(decodeEntities('isn&#39;t'), "isn't");
    assert.equal(decodeEntities('37&quot; chest'), '37" chest');
    assert.equal(decodeEntities('a &amp; b'), 'a & b');
    assert.equal(decodeEntities('&lt;tag&gt;'), '<tag>');
    assert.equal(decodeEntities('a&nbsp;b'), 'a b');
    assert.equal(decodeEntities('don&rsquo;t &mdash; really'), 'don’t — really');
  });

  it('decodes decimal and hex numeric entities', () => {
    assert.equal(decodeEntities('&#66;&#82;&#79;&#79;&#75;&#69;'), 'BROOKE');
    assert.equal(decodeEntities('&#x42;&#x52;'), 'BR');
  });

  it('turns unknown named entities into a space, never into their own letters', () => {
    // Otherwise "&brooke;" in the HTML would satisfy a search for "brooke".
    assert.equal(normalizeForCompare(decodeEntities('&brooke;')), '');
  });

  it('leaves out-of-range and malformed numeric entities as a space', () => {
    assert.equal(decodeEntities('&#0;'), ' ');
    assert.equal(decodeEntities('&#99999999;'), ' ');
  });
});

describe('htmlVisibleText', () => {
  it('drops tags and keeps the words', () => {
    assert.equal(htmlVisibleText('<div><b>Hello</b> there</div>').replace(/\s+/g, ' ').trim(), 'Hello there');
  });

  it('drops script/style content entirely', () => {
    const out = normalizeForCompare(htmlVisibleText('<div>keep<script>var secret = 1;</script></div>'));
    assert.equal(out, 'keep');
  });

  it('drops HTML comments', () => {
    assert.equal(normalizeForCompare(htmlVisibleText('a<!-- hidden note -->b')), 'ab');
  });

  it('handles empty and nullish input', () => {
    assert.equal(htmlVisibleText(''), '');
    assert.equal(htmlVisibleText(null), '');
    assert.equal(htmlVisibleText(undefined), '');
  });
});

// ---------------------------------------------------------------------------
// normalizeForCompare — every asymmetry between the two parts that is NOT
// missing content has to normalize away, or we fall back constantly.
// ---------------------------------------------------------------------------

describe('normalizeForCompare', () => {
  it('ignores case, punctuation and whitespace', () => {
    assert.equal(normalizeForCompare('BROOKE SHAPING BRA (1X)'), 'brookeshapingbra1x');
    assert.equal(
      normalizeForCompare('Brooke  shaping\nbra 1x!'),
      normalizeForCompare('BROOKE SHAPING BRA (1X)'),
    );
  });

  it('treats straight and typographic quotes the same', () => {
    assert.equal(normalizeForCompare("isn't"), normalizeForCompare('isn’t'));
    assert.equal(normalizeForCompare('"quoted"'), normalizeForCompare('“quoted”'));
  });

  it('drops URLs so the plain part\'s "label (https://…)" matches the HTML\'s label', () => {
    assert.equal(
      normalizeForCompare('rubyshines.com (https://rubyshines.com)'),
      normalizeForCompare('rubyshines.com'),
    );
    assert.equal(normalizeForCompare('see www.example.com/thing now'), 'seenow');
  });

  it('drops bare email addresses', () => {
    assert.equal(normalizeForCompare('mail me at care@rubyshines.com ok'), 'mailmeatok');
  });

  it('drops client-inserted image placeholders', () => {
    assert.equal(normalizeForCompare('[image: photo.png] here it is'), 'hereitis');
    assert.equal(normalizeForCompare('[cid:part1.abc] here it is'), 'hereitis');
  });

  it('keeps accented and non-Latin letters (they appear in both parts alike)', () => {
    assert.equal(normalizeForCompare('café'), 'café');
    assert.equal(normalizeForCompare('размер'), 'размер');
  });

  it('drops emoji, which mail clients render inconsistently across parts', () => {
    assert.equal(normalizeForCompare('thanks 🎉'), 'thanks');
  });

  it('handles nullish input', () => {
    assert.equal(normalizeForCompare(null), '');
    assert.equal(normalizeForCompare(undefined), '');
  });
});

// ---------------------------------------------------------------------------
// linesMissingFromHtml — the actual detector
// ---------------------------------------------------------------------------

describe('linesMissingFromHtml', () => {
  it('finds a substantive plain-text line the HTML omits', () => {
    const missing = linesMissingFromHtml(
      'so I think 1X would work.\nBROOKE SHAPING BRA (1X)\nThanks!!',
      '<div>so I think 1X would work.</div>',
    );
    assert.deepEqual(missing, ['BROOKE SHAPING BRA (1X)']);
  });

  it('reports nothing when the HTML says the same thing with markup', () => {
    const missing = linesMissingFromHtml(
      'so I think 1X would work.\nBROOKE SHAPING BRA (1X)',
      '<div>so I think 1X would work.<br><b>BROOKE SHAPING BRA (1X)<br></b></div>',
    );
    assert.deepEqual(missing, []);
  });

  it('sees through markup that splits a word', () => {
    assert.deepEqual(linesMissingFromHtml('BROOKE SHAPING BRA', '<b>BRO</b>OKE <i>SHAPING</i> BRA'), []);
  });

  it('sees through hard-wrapped plain text (format=flowed)', () => {
    const plain = 'The fabric feels very heavy on my skin even before hitting\nthe water and the straps catch.';
    const html = '<div>The fabric feels very heavy on my skin even before hitting the water and the straps catch.</div>';
    assert.deepEqual(linesMissingFromHtml(plain, html), []);
  });

  it('ignores short courtesy lines below the substance threshold', () => {
    // Sign-offs are not worth dropping formatting over; the corpus sweep showed
    // they were the single largest source of pointless fallbacks.
    for (const line of ['Hi Jamie', 'Thanks!!', 'Thanks again,', 'Many thanks,', '916-201-8582']) {
      assert.deepEqual(linesMissingFromHtml(line, '<div>unrelated body text here</div>'), [], line);
    }
  });

  it('still catches the shortest line an operator would act on', () => {
    for (const line of ['Please send 2X', 'Ship to 123 Main St', 'BROOKE SHAPING BRA (1X)']) {
      assert.deepEqual(linesMissingFromHtml(line, '<div>unrelated body text here</div>'), [line], line);
    }
  });

  it('decodes entities on BOTH sides — the plain part keeps them too', () => {
    // Gorgias's plain text is often derived from the HTML and still carries
    // "&#8217;". Decoding only the HTML made every curly apostrophe read as
    // missing content: an 11% false-fallback rate across the stored corpus.
    const plain = 'Hello, I&#8217;m so sorry for the delay. Her waist is 25&#8221;';
    const html = '<div>Hello, I’m so sorry for the delay. Her waist is 25”</div>';
    assert.deepEqual(linesMissingFromHtml(plain, html), []);
  });

  it('ignores zero-width and emoji entities that only one side spells out', () => {
    assert.deepEqual(linesMissingFromHtml('&#65279; Hi there Jamie, all good', '<div>Hi there Jamie, all good</div>'), []);
    assert.deepEqual(linesMissingFromHtml('Thank you so much &#129321; today', '<div>Thank you so much \u{1F389} today</div>'), []);
  });

  it('ignores ">"-quoted lines, so an unrecognised quote header cannot trigger a fallback', () => {
    const plain = 'My new reply is here and it is long enough.\n> quoted line from the previous message';
    const html = '<div>My new reply is here and it is long enough.</div>';
    assert.deepEqual(linesMissingFromHtml(plain, html), []);
  });

  it('does not confuse an entity-encoded HTML body for missing content', () => {
    const plain = 'I suppose it isn\'t jiving with me, 37" chest measurement.';
    const html = '<div>I suppose it isn&#39;t jiving with me, 37&quot; chest measurement.</div>';
    assert.deepEqual(linesMissingFromHtml(plain, html), []);
  });

  it('returns every missing line, not just the first', () => {
    const missing = linesMissingFromHtml(
      'opening line that is long\nBROOKE SHAPING BRA (1X)\nplease ship to 123 Bellwood Ave',
      '<div>opening line that is long</div>',
    );
    assert.deepEqual(missing, ['BROOKE SHAPING BRA (1X)', 'please ship to 123 Bellwood Ave']);
  });
});

// ---------------------------------------------------------------------------
// chooseBody — the decision the operator sees
// ---------------------------------------------------------------------------

describe('chooseBody', () => {
  it('renders escaped plain text when there is no HTML part', () => {
    const r = chooseBody({ body: 'line one\nline <two>' });
    assert.equal(r.source, 'no-html');
    assert.equal(r.html, 'line one<br>line &lt;two&gt;');
  });

  it('handles a message with neither part', () => {
    assert.deepEqual(chooseBody({}), { html: '', source: 'no-html', missingLines: [] });
    assert.deepEqual(chooseBody(null), { html: '', source: 'no-html', missingLines: [] });
  });

  it('keeps the HTML when it carries everything the plain text does', () => {
    const html = '<div>Thanks for the help. I suppose it is just the top that is not working for me.</div>';
    const r = chooseBody({ body: 'Thanks for the help. I suppose it is just the top that is not working for me.', body_html: html });
    assert.equal(r.source, 'html');
    assert.equal(r.html, html);
  });

  it('keeps the HTML for a short reply, where there is nothing to judge by', () => {
    const html = '<div><b>Absolutely!</b></div>';
    const r = chooseBody({ body: 'Absolutely!', body_html: html });
    assert.equal(r.source, 'html');
    assert.equal(r.html, html);
  });

  it('falls back to plain text on the Outlook fragment case (the original bug)', () => {
    const body = 'Absolutely, please send the 2X instead and refund the difference to my card. '
      + 'I am around all week so any delivery day works.';
    const r = chooseBody({ body, body_html: '<div>Absolutely</div>' });
    assert.equal(r.source, 'plain');
    assert.match(r.html, /refund the difference/);
  });

  it('drops the quoted chain when it falls back, matching what the HTML would have shown', () => {
    const body = 'Please send the 2X instead, and refund the difference to my card.\n\n'
      + 'On Wed, Aug 5, 2026 at 5:19 AM RUBIES Customer Care <care@rubyshines.com> wrote:\n> earlier message';
    const r = chooseBody({ body, body_html: '<div>Please send</div>' });
    assert.equal(r.source, 'plain');
    assert.match(r.html, /refund the difference/);
    assert.doesNotMatch(r.html, /earlier message/);
  });

  it('escapes the plain-text fallback (customer text is untrusted)', () => {
    const body = 'Please cancel the order for me, and note that <script>alert(1)</script> is my nickname.';
    const r = chooseBody({ body, body_html: '<div>Please cancel</div>' });
    assert.equal(r.source, 'plain');
    assert.doesNotMatch(r.html, /<script>/);
    assert.match(r.html, /&lt;script&gt;/);
  });

  it('reports the missing lines that drove the decision', () => {
    const body = 'so I think 1X would work and that is what I want to order today.\nBROOKE SHAPING BRA (1X)';
    const r = chooseBody({ body, body_html: '<div>so I think 1X would work and that is what I want to order today.</div>' });
    assert.deepEqual(r.missingLines, ['BROOKE SHAPING BRA (1X)']);
  });

  it('falls back when the HTML has the words but far less of them (structure-loss backstop)', () => {
    // No single plain LINE is missing (the lines are short), yet most of the
    // message is absent from the HTML.
    const body = ['Size: 1X', 'Color: Black', 'Product: Brooke', 'Ship: express', 'Note: gift'].join('\n');
    const r = chooseBody({ body, body_html: '<div>Size: 1X</div>' });
    assert.equal(r.source, 'plain');
  });
});

// ---------------------------------------------------------------------------
// Regression: ticket #111280367 / cs_tickets 3026 (2026-08-05).
// Gorgias's stripped_html cut the bold product line off the end, so the operator
// read "could I return the tankini and get this instead?" with no antecedent for
// "this" — while the advisor, reading body_text, had drafted the right exchange.
// Verbatim payloads from the Gorgias API.
// ---------------------------------------------------------------------------

describe('regression: Gorgias stripped_html drops a trailing line (ticket 111280367)', () => {
  const BODY = [
    'Hi Jamie, ',
    '',
    'thanks for the help. ',
    '',
    'I suppose its just the top (the tankini) that isn\'t jiving with me. The fabric feels very heavy on my skin even before hitting the water, and then once its wet feels very difficult to pull off with the various straps catching on my skin. ',
    '',
    'Rather than a refund, could I return the tankini and get this instead? I know its not swimwear but I like the design. 37" chest measurement so I think 1X would work. ',
    'BROOKE SHAPING BRA (1X) ',
    '',
    'Thanks!! ',
    '',
    'On Wed, Aug 5, 2026 at 5:19 AM RUBIES Customer Care < care@rubyshines.com> wrote: (mailto:care@rubyshines.com) ',
    '',
    'Hi, ',
    '',
    'Before I set up a return, can you tell me a bit more about what feels uncomfortable? ',
  ].join('\n');

  const STRIPPED_HTML = '<html><body><div dir="ltr"><div dir="ltr">Hi Jamie,</div><div dir="ltr"><br></div>'
    + '<div dir="ltr">thanks for the help.<br><br>I suppose its just the top (the tankini) that isn\'t jiving '
    + 'with me. The fabric feels very heavy on my skin even before hitting the water, and then once its wet '
    + 'feels very difficult to pull off with the various straps catching on my skin.<br><br>Rather than a '
    + 'refund, could I return the tankini and get this instead? I know its not swimwear but I like the design. '
    + '37" chest measurement so I think 1X would work.</div></div>\n</body></html>';

  const FULL_HTML = '<div dir="ltr"><div dir="ltr">Hi Jamie,</div><div dir="ltr"><br></div>'
    + '<div dir="ltr">thanks for the help.<br><br>I suppose its just the top (the tankini) that isn&#39;t jiving '
    + 'with me. The fabric feels very heavy on my skin even before hitting the water, and then once its wet '
    + 'feels very difficult to pull off with the various straps catching on my skin.<br><br>Rather than a '
    + 'refund, could I return the tankini and get this instead? I know its not swimwear but I like the design. '
    + '37&quot; chest measurement so I think 1X would work.<br><br><b>BROOKE SHAPING BRA (1X)<br></b><br>Thanks!!</div>'
    + '<div class="gmail_quote"><div dir="ltr" class="gmail_attr">On Wed, Aug 5, 2026 at 5:19 AM RUBIES Customer '
    + 'Care &lt;<a href="mailto:care@rubyshines.com">care@rubyshines.com</a>&gt; wrote:<br></div>'
    + '<blockquote class="gmail_quote"><div><p>Hi,</p></div></blockquote></div></div>';

  it('the old length-ratio rule would NOT have caught this', () => {
    // ~93% of the plain text survived — nowhere near the 0.6 threshold. This is
    // why the detector is line-level, not length-level.
    const plain = plainTextBeforeQuote(BODY);
    const ratio = normalizeForCompare(htmlVisibleText(STRIPPED_HTML)).length / normalizeForCompare(plain).length;
    assert.ok(ratio > 0.6, `expected the stripped html to be >60% of the plain text, got ${ratio}`);
  });

  it('falls back to plain text and shows the product the customer named', () => {
    const r = chooseBody({ body: BODY, body_html: STRIPPED_HTML });
    assert.equal(r.source, 'plain');
    assert.deepEqual(r.missingLines, ['BROOKE SHAPING BRA (1X)']);
    assert.match(r.html, /BROOKE SHAPING BRA \(1X\)/);
  });

  it('keeps the operator\'s view free of the quoted chain it never had', () => {
    const r = chooseBody({ body: BODY, body_html: STRIPPED_HTML });
    assert.doesNotMatch(r.html, /Before I set up a return/);
  });

  it('keeps the rich HTML when Gorgias strips correctly (same mail, full body_html)', () => {
    const r = chooseBody({ body: BODY, body_html: FULL_HTML });
    assert.equal(r.source, 'html');
    assert.equal(r.html, FULL_HTML);
  });

  it('pickRichestBody returns the same markup chooseBody chose', () => {
    assert.equal(pickRichestBody({ body: BODY, body_html: STRIPPED_HTML }), chooseBody({ body: BODY, body_html: STRIPPED_HTML }).html);
  });
});

// ---------------------------------------------------------------------------
// Corpus-shaped cases. Replaying the rule over every stored customer message
// (1,375 with an HTML part) put the fallback rate at 4.4%. These pin the message
// shapes that decided where that number landed — synthetic stand-ins for the
// real ones, so no customer detail lives in the repo.
// ---------------------------------------------------------------------------

describe('corpus-shaped cases', () => {
  const withHtml = (body, body_html) => chooseBody({ body, body_html });

  it('keeps HTML for an ordinary reply whose plain part is entity-encoded', () => {
    const body = 'Thanks for getting back to me. I&#8217;d like the 1X in black please, and I&#8217;m happy to wait for the restock.';
    const html = '<div dir="auto">Thanks for getting back to me. I’d like the 1X in black please, and I’m happy to wait for the restock.</div>';
    assert.equal(withHtml(body, html).source, 'html');
  });

  it('keeps HTML when the only difference is a stripped mail-client sign-off', () => {
    const body = 'Yes please go ahead and swap it for the medium, that sounds right to me.\nAlix\nSent from my T-Mobile 5G Device';
    const html = '<div>Yes please go ahead and swap it for the medium, that sounds right to me.</div>';
    assert.equal(withHtml(body, html).source, 'html');
  });

  it('keeps HTML when the only difference is a quoted agent reply Gorgias stripped', () => {
    const body = 'That sounds perfect, let us go with the medium.\n'
      + 'May 14, 2026 10:30:25 PM RUBIES Customer Care <care@rubyshines.com>: \n'
      + 'Since you were between a M and L and the L is feeling loose all over, the M would be the way to go.';
    const html = '<div>That sounds perfect, let us go with the medium.</div>';
    assert.equal(withHtml(body, html).source, 'html');
  });

  it('falls back when a stripped signature block carries a shipping address', () => {
    // The failure mode parked.md has been watching since 2026-04-27: a customer
    // puts the address they want the exchange sent to in their sign-off, and the
    // HTML we render drops it. Losing formatting is the cheaper mistake.
    const body = 'Could you send the replacement to my new place instead? Thanks so much for sorting this out.\n'
      + 'Tina Whitcher\n28030 227th Pl SE\nMaple Valley, WA 98038';
    const html = '<div>Could you send the replacement to my new place instead? Thanks so much for sorting this out.</div>';
    const r = withHtml(body, html);
    assert.equal(r.source, 'plain');
    assert.match(r.html, /Maple Valley/);
  });

  it('falls back when the HTML drops a whole paragraph of the customer\'s message', () => {
    const body = 'I just submitted a return for order #30694. Not sure how I made the mistake but I ordered kids sizing in some.\n'
      + 'I placed another order right away, so I am really hoping you can process this return quickly.';
    const html = '<div>I just submitted a return for order #30694. Not sure how I made the mistake but I ordered kids sizing in some.</div>';
    assert.equal(withHtml(body, html).source, 'plain');
  });
});

// ---------------------------------------------------------------------------
// Browser wiring. app.js destructures these off `window.messageBody` at parse
// time, so a missing export or a script-tag ordering slip white-screens the
// whole dashboard — and app.js itself has no test harness to catch it.
// ---------------------------------------------------------------------------

describe('dashboard wiring', () => {
  it('exposes window.messageBody when loaded as a plain browser script', () => {
    const sandbox = { window: {} };
    sandbox.self = sandbox.window;
    vm.runInNewContext(fs.readFileSync(path.join(PUBLIC_DIR, 'messageBody.js'), 'utf8'), sandbox);
    assert.ok(sandbox.window.messageBody, 'messageBody.js did not attach to window');
    assert.equal(typeof sandbox.window.messageBody.pickRichestBody, 'function');
  });

  it('exports every name app.js destructures off window.messageBody', () => {
    const app = fs.readFileSync(path.join(PUBLIC_DIR, 'app.js'), 'utf8');
    const m = app.match(/const\s*\{([^}]+)\}\s*=\s*window\.messageBody;/);
    assert.ok(m, 'app.js no longer destructures window.messageBody — update this test');
    const names = m[1].split(',').map(s => s.trim()).filter(Boolean);
    assert.ok(names.length > 0);
    const api = require('../dashboard/public/messageBody');
    for (const name of names) {
      assert.equal(typeof api[name], 'function', `messageBody.js does not export ${name}`);
    }
  });

  it('index.html loads messageBody.js before app.js', () => {
    const html = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
    const mod = html.indexOf('/messageBody.js');
    const app = html.indexOf('/app.js');
    assert.ok(mod > -1, 'index.html does not load messageBody.js');
    assert.ok(app > -1 && mod < app, 'messageBody.js must load before app.js');
  });

  it('app.js no longer carries its own copy of the picker', () => {
    const app = fs.readFileSync(path.join(PUBLIC_DIR, 'app.js'), 'utf8');
    assert.doesNotMatch(app, /function pickRichestBody\s*\(/);
    assert.doesNotMatch(app, /function plainTextBeforeQuote\s*\(/);
  });
});
