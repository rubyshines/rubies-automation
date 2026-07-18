const test = require('node:test');
const assert = require('node:assert');

const { candidateToArticle } = require('../import/rebuildKnowledgeBase');

test('candidateToArticle maps published candidates to website-source articles', () => {
  const a = candidateToArticle({
    id: 'page:size-guide#main',
    source_url: 'https://rubyshines.com/pages/size-guide',
    title: 'RUBIES Size Guide',
    category: 'sizing',
    content: 'Sizing overview content.',
    trust: 'published',
  });
  assert.strictEqual(a.id, 'page:size-guide#main');
  assert.strictEqual(a.source, 'website');
  assert.strictEqual(a.trust, 'published');
  assert.strictEqual(a.priority, 5);
  assert.strictEqual(a.source_url, 'https://rubyshines.com/pages/size-guide');
});

test('candidateToArticle maps reply-corpus candidates with lower priority', () => {
  const a = candidateToArticle({
    id: 'reply:abc123#main',
    source_url: 'internal://reply-corpus/abc123',
    title: 'Exchanges ship free',
    category: 'policy',
    content: 'Exchange shipping covered up to 3 per order.',
    trust: 'reply_corpus',
  });
  assert.strictEqual(a.source, 'reply_corpus');
  assert.strictEqual(a.priority, 4);
});

test('candidateToArticle derives a title when missing', () => {
  const a = candidateToArticle({ id: 'x#main', source_url: 'u', title: null, category: 'faq', content: 'Some fact content here.', trust: 'reply_corpus' });
  assert.strictEqual(a.title, 'Some fact content here.');
});
