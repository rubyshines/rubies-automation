const test = require('node:test');
const assert = require('node:assert');

const {
  stripHtml,
  extractMainContent,
  extractPageTitle,
  hashContent,
  composeProductContent,
  isJunkSource,
} = require('../import/harvestKbSources');

test('stripHtml removes tags, chrome elements, and decodes entities', () => {
  const html = `
    <style>.x{color:red}</style>
    <script>alert(1)</script>
    <nav><a href="/">Home</a></nav>
    <header>Announcement</header>
    <h1>Size &amp; Fit</h1>
    <p>Runs true to size &ndash; order your usual.</p>
    <footer>© RUBIES</footer>
  `;
  const text = stripHtml(html);
  assert.ok(!text.includes('color:red'));
  assert.ok(!text.includes('alert'));
  assert.ok(!text.includes('Home'));
  assert.ok(!text.includes('Announcement'));
  assert.ok(!text.includes('© RUBIES'));
  assert.ok(text.includes('Size & Fit'));
  assert.ok(text.includes('order your usual'));
});

test('stripHtml inserts line breaks at block boundaries', () => {
  const text = stripHtml('<h2>Shipping</h2><p>Ships in 2 days.</p><li>Free over $80</li>');
  assert.deepStrictEqual(text.split('\n'), ['Shipping', 'Ships in 2 days.', 'Free over $80']);
});

test('stripHtml handles empty/null input', () => {
  assert.strictEqual(stripHtml(''), '');
  assert.strictEqual(stripHtml(null), '');
  assert.strictEqual(stripHtml(undefined), '');
});

test('extractMainContent prefers <main> over full document', () => {
  const html = '<body><div>Menu junk</div><main id="MainContent"><p>The real page</p></main><div>More junk</div></body>';
  const text = extractMainContent(html);
  assert.strictEqual(text, 'The real page');
});

test('extractMainContent falls back to whole document without <main>', () => {
  const text = extractMainContent('<body><p>Only content</p></body>');
  assert.strictEqual(text, 'Only content');
});

test('extractPageTitle decodes entities, collapses whitespace, strips RUBIES suffix', () => {
  assert.strictEqual(
    extractPageTitle('<title>Our Story\n &ndash; RUBIES</title>', 'x'),
    'Our Story'
  );
  assert.strictEqual(
    extractPageTitle('<title>Size &amp; Fit | RUBIES</title>', 'x'),
    'Size & Fit'
  );
  assert.strictEqual(extractPageTitle('<body>no title</body>', '/pages/foo'), '/pages/foo');
  assert.strictEqual(extractPageTitle('<title>&ndash; RUBIES</title>', 'fallback'), 'fallback');
});

test('hashContent is stable and input-sensitive', () => {
  assert.strictEqual(hashContent('abc'), hashContent('abc'));
  assert.notStrictEqual(hashContent('abc'), hashContent('abd'));
  assert.strictEqual(hashContent(''), hashContent(null)); // both hash empty string
});

test('composeProductContent renders description, sizes, colors, price range', () => {
  const product = {
    title: 'AJ SHAPING UNDERWEAR',
    descriptionHtml: '<p>Our classic no-tuck brief.</p>',
    seo: { description: 'Gender-affirming underwear.' },
    variants: [
      { price: '42.00', selectedOptions: [{ name: 'Size', value: 'S' }, { name: 'Color', value: 'Black' }] },
      { price: '46.00', selectedOptions: [{ name: 'Size', value: 'XL' }, { name: 'Color', value: 'Pink' }] },
    ],
  };
  const { content, sizes, colors, priceMin, priceMax } = composeProductContent(product);
  assert.ok(content.startsWith('# AJ SHAPING UNDERWEAR'));
  assert.ok(content.includes('Our classic no-tuck brief.'));
  assert.ok(content.includes('Available sizes: S, XL'));
  assert.ok(content.includes('Available colors: Black, Pink'));
  assert.ok(content.includes('Price range: $42.00 – $46.00'));
  assert.ok(content.includes('Gender-affirming underwear.'));
  assert.deepStrictEqual(sizes, ['S', 'XL']);
  assert.deepStrictEqual(colors, ['Black', 'Pink']);
  assert.strictEqual(priceMin, 42);
  assert.strictEqual(priceMax, 46);
});

test('composeProductContent single price and no options', () => {
  const { content } = composeProductContent({
    title: 'GIFT CARD',
    descriptionHtml: '<p>A RUBIES gift card for any occasion.</p>',
    variants: [{ price: '50.00', selectedOptions: [] }],
  });
  assert.ok(content.includes('Price: $50.00'));
  assert.ok(!content.includes('Available sizes'));
});

test('isJunkSource filters mechanical junk, keeps real content', () => {
  assert.ok(isJunkSource('website:/pages/test'));
  assert.ok(isJunkSource('website:/pages/test-page'));
  assert.ok(isJunkSource('website:/pages/redirect-page'));
  assert.ok(isJunkSource('website:/pages/multi-feed-for-google-shopping-rbqc_4268620751'));
  assert.ok(isJunkSource('website:/pages/rubies-friendships-signup'));
  assert.ok(isJunkSource('collection:orderlyemails-recommended-products'));
  // real content stays
  assert.ok(!isJunkSource('website:/pages/about-us'));
  assert.ok(!isJunkSource('website:/pages/testimonials')); // 'test' prefix must not overmatch
  assert.ok(!isJunkSource('page:rubies-friendships-how-it-works'));
  assert.ok(!isJunkSource('product:the-aj-shaping-underwear'));
  assert.ok(!isJunkSource('policy:refund_policy'));
});
