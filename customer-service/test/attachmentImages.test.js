const test = require('node:test');
const assert = require('node:assert');

const {
  selectImageAttachments,
  attachmentOnlyPlaceholder,
  fetchImagesAsBlocks,
} = require('../lib/attachmentImages');

const png = (name, url) => ({ name, url, content_type: 'image/png' });

test('selectImageAttachments keeps supported types, drops the rest', () => {
  const picked = selectImageAttachments([
    png('a.png', 'https://u/a.png'),
    { name: 'b.heic', url: 'https://u/b.heic', content_type: 'image/heic' },
    { name: 'c.pdf', url: 'https://u/c.pdf', content_type: 'application/pdf' },
    { name: 'no-url.png', content_type: 'image/png' },
    { name: 'd.jpg', url: 'https://u/d.jpg', content_type: 'image/jpeg' },
  ]);
  assert.deepStrictEqual(picked.map(a => a.name), ['a.png', 'd.jpg']);
});

test('selectImageAttachments caps at max', () => {
  const many = Array.from({ length: 8 }, (_, i) => png(`${i}.png`, `https://u/${i}.png`));
  assert.strictEqual(selectImageAttachments(many).length, 4);
  assert.strictEqual(selectImageAttachments(many, { max: 2 }).length, 2);
});

test('selectImageAttachments tolerates null/empty input', () => {
  assert.deepStrictEqual(selectImageAttachments(null), []);
  assert.deepStrictEqual(selectImageAttachments([]), []);
});

test('attachmentOnlyPlaceholder pluralizes', () => {
  assert.strictEqual(attachmentOnlyPlaceholder([png('a.png')]), '[Customer sent 1 attachment with no message text]');
  assert.strictEqual(
    attachmentOnlyPlaceholder([png('a.png'), png('b.png'), png('c.png')]),
    '[Customer sent 3 attachments with no message text]'
  );
});

test('fetchImagesAsBlocks returns base64 vision blocks', async () => {
  const bytes = Buffer.from('fake-png-bytes');
  const fetchImpl = async () => ({ ok: true, arrayBuffer: async () => bytes });
  const blocks = await fetchImagesAsBlocks([png('a.png', 'https://u/a.png')], { fetchImpl });
  assert.strictEqual(blocks.length, 1);
  assert.deepStrictEqual(blocks[0], {
    type: 'image',
    source: { type: 'base64', media_type: 'image/png', data: bytes.toString('base64') },
  });
});

test('fetchImagesAsBlocks drops failed, oversized, and throwing fetches without rejecting', async () => {
  const small = Buffer.from('ok');
  const big = Buffer.alloc(64);
  const responses = {
    'https://u/ok.png': { ok: true, arrayBuffer: async () => small },
    'https://u/404.png': { ok: false, status: 404 },
    'https://u/big.png': { ok: true, arrayBuffer: async () => big },
  };
  const fetchImpl = async (url) => {
    if (url === 'https://u/boom.png') throw new Error('network down');
    return responses[url];
  };
  const blocks = await fetchImagesAsBlocks(
    [png('ok.png', 'https://u/ok.png'), png('404.png', 'https://u/404.png'), png('big.png', 'https://u/big.png'), png('boom.png', 'https://u/boom.png')],
    { fetchImpl, maxBytes: 32 }
  );
  assert.strictEqual(blocks.length, 1);
  assert.strictEqual(blocks[0].source.data, small.toString('base64'));
});
