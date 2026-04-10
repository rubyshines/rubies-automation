const { autoLinkProducts } = require('../lib/autoLinker');

let passed = 0;
let failed = 0;

function test(name, input, expectContains, expectNotContains) {
  const result = autoLinkProducts(input);
  const errors = [];

  for (const expected of (expectContains || [])) {
    if (!result.includes(expected)) {
      errors.push(`  MISSING: ${expected}`);
    }
  }
  for (const notExpected of (expectNotContains || [])) {
    if (result.includes(notExpected)) {
      errors.push(`  UNWANTED: ${notExpected}`);
    }
  }

  if (errors.length) {
    failed++;
    console.log(`FAIL: ${name}`);
    console.log(`  Input:  "${input}"`);
    console.log(`  Output: "${result}"`);
    errors.forEach(e => console.log(e));
  } else {
    passed++;
    console.log(`PASS: ${name}`);
  }
}

console.log('=== Auto-Linker Tests ===\n');

// --- Markdown link conversion ---

test('Markdown link converts to HTML',
  'Try the [AJ](https://rubyshines.com/products/the-aj-shaping-underwear) in a size M.',
  ['<a href="https://rubyshines.com/products/the-aj-shaping-underwear"', '>AJ</a>', 'in a size M'],
);

test('Multiple markdown links',
  'The [Sassy](https://rubyshines.com/products/the-sassy-no-tuck-shaping-underwear) or the [Cheeky](https://rubyshines.com/products/the-cheeky-shaping-bikini-bottom) would both work.',
  ['>Sassy</a>', '>Cheeky</a>'],
);

test('Link styling applied',
  'Try the [Ruby](https://rubyshines.com/products/the-ruby-no-tuck-shaping-bikini-bottom).',
  ['style="color:#1a7f64;text-decoration:underline"'],
);

// --- Plain text (no links) passes through ---

test('Plain text without links',
  'The AJ in Medium was a bit tight.',
  ['<p>The AJ in Medium was a bit tight.</p>'],
  ['<a href='],
);

test('No product mentions',
  'Thanks for reaching out! Happy to help.',
  ['<p>'],
  ['<a href='],
);

// --- Structure ---

test('Newlines become <br>',
  'Hi!\n\nTry the [Flo](https://rubyshines.com/products/the-flo-shaping-dance-underwear) in a size S.\n\nTalk soon,\nJamie',
  ['>Flo</a>', '<br>', '<p>'],
);

test('Empty string',
  '',
  [],
);

// --- Realistic advisor responses ---

test('Exchange recommendation with link',
  'Since the AJ in Medium was a bit tight, I would recommend trying the [AJ](https://rubyshines.com/products/the-aj-shaping-underwear) in a size L.',
  ['>AJ</a> in a size L'],
);

test('Style switch with two links',
  'The [Sassy](https://rubyshines.com/products/the-sassy-no-tuck-shaping-underwear) might be a great alternative to the Charlie since it has a wider leg opening.',
  ['>Sassy</a> might be a great alternative'],
  // Charlie is NOT linked because the AI chose not to link it (just referencing what they have)
);

test('Full realistic reply with link',
  `Hi! Thanks so much for reaching out.

Since the Flo in size 14 was a little snug, I would suggest trying the [Sassy](https://rubyshines.com/products/the-sassy-no-tuck-shaping-underwear) in a size S.

Talk soon,
Jamie Alexander, RUBIES Founder`,
  ['>Sassy</a>', '<br>'],
);

// --- Edge: non-product markdown links preserved ---

test('Non-product markdown link also converts',
  'Check our [size guide](https://rubyshines.com/pages/size-guide) for details.',
  ['>size guide</a>', 'rubyshines.com/pages/size-guide'],
);

// --- Summary ---
console.log('\n========================');
console.log(`Results: ${passed} passed, ${failed} failed out of ${passed + failed}`);
if (failed > 0) process.exit(1);
