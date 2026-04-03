const { autoLinkProducts } = require('../lib/autoLinker');

// Realistic product config matching current Supabase nicknames
const PRODUCTS = [
  { product_handle: 'the-aj-no-tuck-shaping-underwear', nickname: 'AJ underwear', category: 'underwear_bottom', keywords: ['aj'] },
  { product_handle: 'the-charlie-no-tuck-extra-cute-shaping-underwear', nickname: 'Charlie underwear', category: 'underwear_bottom', keywords: ['charlie'] },
  { product_handle: 'the-sassy-no-tuck-shaping-underwear', nickname: 'Sassy underwear', category: 'underwear_bottom', keywords: ['sassy'] },
  { product_handle: 'the-flo-shaping-dance-underwear', nickname: 'Flo underwear', category: 'underwear_bottom', keywords: ['flo'] },
  { product_handle: 'the-naomi-gaff-extra-strength-shaping-underwear', nickname: 'Naomi gaff', category: 'underwear_bottom', keywords: ['naomi', 'gaff'] },
  { product_handle: 'the-brooke-shaping-bra', nickname: 'Brooke bra', category: 'underwear_top', keywords: ['brooke'] },
  { product_handle: 'the-ava-seamless-shaping-bra', nickname: 'Ava bra', category: 'underwear_top', keywords: ['ava'] },
  { product_handle: 'the-ruby-no-tuck-shaping-bikini-bottom', nickname: 'Ruby bikini bottom', category: 'swim_bottom', keywords: ['ruby'] },
  { product_handle: 'the-cheeky-no-tuck-shaping-bikini-bottom', nickname: 'Cheeky bikini bottom', category: 'swim_bottom', keywords: ['cheeky'] },
  { product_handle: 'the-mia-halter-bikini-top', nickname: 'Mia halter', category: 'swim_top', keywords: ['mia'] },
  { product_handle: 'the-sky-no-tuck-shaping-one-piece', nickname: 'Sky one-piece', category: 'onepiece', keywords: ['sky', 'one-piece'] },
  { product_handle: 'the-stella-high-waisted-shaping-bikini-bottom', nickname: 'Stella bikini bottom', category: 'swim_bottom', keywords: ['stella'] },
  { product_handle: 'the-serena-no-tuck-shaping-shorty-short', nickname: 'Serena shorts', category: 'swim_bottom', keywords: ['serena'] },
  { product_handle: 'the-sunny-queeny-tankini', nickname: 'Queeny tankini', category: 'swim_top', keywords: ['queeny', 'sunny', 'tankini'] },
  { product_handle: 'rubies-shaping-chest-pads', nickname: 'Chest Pads', category: 'chest_pads', keywords: ['pad'] },
  { product_handle: 'rubies-gift-card', nickname: 'Gift Card', category: 'accessory', keywords: ['gift card'] },
  { product_handle: 'progress-pride-pins', nickname: 'Pride Pins', category: 'accessory', keywords: ['pins'] },
];

const URL = 'https://rubyshines.com/products';
let passed = 0;
let failed = 0;

function test(name, input, expectContains, expectNotContains) {
  const result = autoLinkProducts(input, PRODUCTS);
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

// --- Nickname normalization + linking ---

test('Bare nickname normalizes to full nickname',
  'Are you aware we have the Flo?',
  [`>Flo underwear</a>`],
);

test('"the" stays outside link',
  'Try the AJ for everyday wear.',
  ['the <a href=', '>AJ underwear</a>'],
);

test('Preserves uppercase "The" at sentence start',
  'The Sassy is our most popular style!',
  ['The <a href=', '>Sassy underwear</a>'],
);

test('Bare nickname without "the"',
  'Charlie is great for everyday wear.',
  ['>Charlie underwear</a>'],
);

// --- Full phrase still works ---

test('Full phrase "the Flo underwear" normalizes',
  'Have you tried the Flo underwear?',
  ['the <a href=', '>Flo underwear</a>'],
);

test('Verbose phrase normalizes to nickname',
  'the Flo shaping dance underwear is great',
  ['the <a href=', '>Flo underwear</a>'],
);

// --- Multiple products ---

test('Two products',
  'The AJ and the Sassy are both great.',
  [
    `<a href="${URL}/the-aj-no-tuck-shaping-underwear"`,
    `<a href="${URL}/the-sassy-no-tuck-shaping-underwear"`,
    '>AJ underwear</a>',
    '>Sassy underwear</a>',
  ],
);

test('Three products',
  'We have the Flo for dance, the Ruby for swim, and the AJ for everyday.',
  [
    '>Flo underwear</a>',
    '>Ruby bikini bottom</a>',
    '>AJ underwear</a>',
  ],
);

// --- Keywords ---

test('Keyword "gaff" normalizes to Naomi gaff',
  'Our gaff provides extra strength shaping.',
  ['>Naomi gaff</a>'],
);

test('Keyword "tankini" normalizes to Queeny tankini',
  'Have you seen our tankini?',
  ['>Queeny tankini</a>'],
);

test('Keyword "one-piece" normalizes to Sky one-piece',
  'The one-piece is perfect for beach days.',
  ['>Sky one-piece</a>'],
);

// --- Case insensitivity ---

test('Lowercase input normalizes to proper case',
  'try the flo or sassy',
  ['>Flo underwear</a>', '>Sassy underwear</a>'],
);

test('Uppercase input normalizes',
  'Try SASSY.',
  ['>Sassy underwear</a>'],
);

// --- Accessories excluded ---

test('Gift card not linked',
  'Would you like a Gift Card instead?',
  [],
  [`<a href="${URL}/rubies-gift-card"`],
);

test('Pride Pins not linked',
  'We also have Pride Pins available.',
  [],
  [`<a href="${URL}/progress-pride-pins"`],
);

// --- Structure ---

test('Multi-line message preserves breaks',
  'Hi there!\n\nTry the Flo in a size S.\n\nTalk soon,\nJamie',
  ['>Flo underwear</a>', '<br>', '<p>'],
);

// --- Edge cases ---

test('No product mentions',
  'Thanks for reaching out! Happy to help.',
  ['<p>'],
  [`<a href="`],
);

test('Empty string',
  '',
  [],
);

test('Product name inside word does NOT match',
  'The flavoring was amazing.',
  [],
  [`<a href="`],
);

test('Product followed by punctuation',
  'Have you tried the Cheeky? It is popular!',
  ['>Cheeky bikini bottom</a>'],
);

test('Products in parentheses',
  'Our swim line (Ruby, Cheeky, Stella) is great.',
  ['>Ruby bikini bottom</a>', '>Cheeky bikini bottom</a>', '>Stella bikini bottom</a>'],
);

// --- Realistic CS responses ---

test('Exchange recommendation',
  'Since the AJ in Medium was a bit tight, I would recommend trying the AJ in a size L.',
  ['>AJ underwear</a>'],
);

test('Style switch',
  'The Sassy might be a great alternative to the Charlie.',
  ['>Sassy underwear</a>', '>Charlie underwear</a>'],
);

test('Swim recommendation',
  'I suggest the Ruby bikini bottom with the Mia top. The Sky one-piece is also lovely!',
  ['>Ruby bikini bottom</a>', '>Mia halter</a>', '>Sky one-piece</a>'],
);

test('Full realistic reply',
  `Hi! Thanks so much for reaching out.

Since the Flo in size 14 was a little snug, I would suggest trying the Sassy in a size S.

Talk soon,
Jamie Alexander, RUBIES Founder`,
  ['>Flo underwear</a>', '>Sassy underwear</a>', '<br>'],
);

test('Same product mentioned twice',
  'The AJ in Medium was tight. Try the AJ in a size L.',
  // Should have two links
  ['>AJ underwear</a> in Medium', '>AJ underwear</a> in a size L'],
);

// --- Summary ---
console.log('\n========================');
console.log(`Results: ${passed} passed, ${failed} failed out of ${passed + failed}`);
if (failed > 0) process.exit(1);
