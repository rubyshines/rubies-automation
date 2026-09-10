/**
 * Automatic publishing of the wholesale pricing page (2026-09-10): the
 * changed-or-not comparison, the GitHub Contents client against a stubbed
 * fetch, and the mode selection in publishWholesalePricing.
 */
const { test } = require('node:test');
const assert = require('node:assert');

const { sameIgnoringKeys, canonical, putJsonIfChanged, hasGithubToken } = require('../lib/githubContents');
const { publishWholesalePricing, autoPublishWholesalePricing, STAMP_KEYS, ASSET_PATH } = require('../lib/wholesalePriceListPublish');

const PAYLOAD = {
  generated_at: '2026-09-10T12:00:00.000Z', discount_percent: 50, currency: 'USD',
  sections: [{ name: 'Underwear', products: [{ product: 'AJ', bands: [{ sizes: 'Youth 4-10', retail: 28, wholesale: 14 }] }] }],
};

// ── comparison ──────────────────────────────────────────────────────────────

test('a timestamp-only difference is not a change; a price is; array order is', () => {
  const later = { ...PAYLOAD, generated_at: '2026-09-11T12:00:00.000Z' };
  assert.ok(sameIgnoringKeys(PAYLOAD, later, STAMP_KEYS));
  assert.ok(!sameIgnoringKeys(PAYLOAD, later, []), 'without the ignore list the stamp counts');
  const repriced = JSON.parse(JSON.stringify(later));
  repriced.sections[0].products[0].bands[0].retail = 30;
  assert.ok(!sameIgnoringKeys(PAYLOAD, repriced, STAMP_KEYS));
  // Key order in the stored file never matters (jsonb and pretty-printers reorder).
  assert.ok(sameIgnoringKeys({ b: 1, a: [1, 2] }, { a: [1, 2], b: 1 }));
  assert.ok(!sameIgnoringKeys({ a: [1, 2] }, { a: [2, 1] }), 'position is meaning');
  assert.equal(canonical({ b: 1, a: 'x' }), '{"a":"x","b":1}');
});

// ── the Contents client ─────────────────────────────────────────────────────

function fetchStub(existing, { putStatus = 200 } = {}) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, method: init.method, body: init.body ? JSON.parse(init.body) : null, auth: init.headers.Authorization });
    if (init.method === 'GET') {
      if (!existing) return { status: 404, ok: false, json: async () => ({}) };
      return { status: 200, ok: true, json: async () => ({ sha: 'oldsha', content: Buffer.from(JSON.stringify(existing)).toString('base64') }) };
    }
    return {
      status: putStatus, ok: putStatus < 300,
      json: async () => (putStatus < 300 ? { content: { sha: 'newsha' }, commit: { sha: 'c0ffee', html_url: 'https://github.com/x/y/commit/c0ffee' } } : { message: 'Bad credentials' }),
    };
  };
  return { impl, calls };
}

test('unchanged data on the branch → no PUT', async () => {
  const stored = { ...PAYLOAD, generated_at: '2026-09-01T00:00:00.000Z' };
  const { impl, calls } = fetchStub(stored);
  const res = await putJsonIfChanged({ owner: 'o', repo: 'r', path: ASSET_PATH, content: PAYLOAD, ignoreKeys: STAMP_KEYS, message: 'm', token: 't', fetchImpl: impl });
  assert.deepEqual(res, { noOp: true, sha: 'oldsha', commitSha: null, commitUrl: null });
  assert.deepEqual(calls.map(c => c.method), ['GET']);
  assert.equal(calls[0].auth, 'Bearer t');
  assert.match(calls[0].url, /\/repos\/o\/r\/contents\/assets\/wholesale-pricing\.json\?ref=main$/);
});

test('changed data → PUT with the existing sha, on main, pretty JSON', async () => {
  const stored = JSON.parse(JSON.stringify(PAYLOAD));
  stored.sections[0].products[0].bands[0].retail = 26;
  const { impl, calls } = fetchStub(stored);
  const res = await putJsonIfChanged({ owner: 'o', repo: 'r', path: ASSET_PATH, content: PAYLOAD, ignoreKeys: STAMP_KEYS, message: 'data: x', token: 't', fetchImpl: impl });
  assert.equal(res.noOp, false);
  assert.equal(res.commitSha, 'c0ffee');
  const put = calls.find(c => c.method === 'PUT');
  assert.equal(put.body.sha, 'oldsha');
  assert.equal(put.body.branch, 'main');
  assert.equal(put.body.message, 'data: x');
  const written = Buffer.from(put.body.content, 'base64').toString('utf8');
  assert.deepEqual(JSON.parse(written), PAYLOAD);
  assert.ok(written.endsWith('}\n'), 'pretty-printed with a trailing newline, like the worktree flow');
});

test('a missing file is created (no sha), and an API error is loud', async () => {
  const { impl, calls } = fetchStub(null);
  const res = await putJsonIfChanged({ owner: 'o', repo: 'r', path: ASSET_PATH, content: PAYLOAD, message: 'm', token: 't', fetchImpl: impl });
  assert.equal(res.noOp, false);
  assert.equal(calls.find(c => c.method === 'PUT').body.sha, undefined);

  const bad = fetchStub(null, { putStatus: 401 });
  await assert.rejects(
    () => putJsonIfChanged({ owner: 'o', repo: 'r', path: ASSET_PATH, content: PAYLOAD, message: 'm', token: 't', fetchImpl: bad.impl }),
    /GitHub PUT .*401: Bad credentials/);
  await assert.rejects(() => putJsonIfChanged({ owner: 'o', repo: 'r', path: ASSET_PATH, content: PAYLOAD, message: 'm', token: null }), /GITHUB_TOKEN/);
});

test('hasGithubToken reads either variable and nothing else', () => {
  assert.ok(hasGithubToken({ GITHUB_TOKEN: 'a' }));
  assert.ok(hasGithubToken({ GH_TOKEN: 'b' }));
  assert.ok(!hasGithubToken({}));
});

// ── mode selection and the unattended wrapper ───────────────────────────────

test('via github: publishes through the Contents client and reports the standard shape', async () => {
  const seen = [];
  const putJson = async (args) => { seen.push(args); return { noOp: false, sha: 's', commitSha: 'c0ffee', commitUrl: 'https://github.com/x/y/commit/c0ffee' }; };
  const res = await publishWholesalePricing({ via: 'github', payload: PAYLOAD, putJson });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].owner, 'rubyshines');
  assert.equal(seen[0].repo, 'rubies-ecom-v4');
  assert.equal(seen[0].path, ASSET_PATH);
  assert.deepEqual(seen[0].ignoreKeys, STAMP_KEYS);
  assert.match(seen[0].message, /^data: update wholesale-pricing\.json \(1 products at 50%\)/);
  assert.equal(res.via, 'github');
  assert.equal(res.merged, true);
  assert.equal(res.count, 1);
  assert.equal(res.prUrl, 'https://github.com/x/y/commit/c0ffee');

  const quiet = await publishWholesalePricing({ via: 'github', payload: PAYLOAD, putJson: async () => ({ noOp: true }) });
  assert.equal(quiet.noOp, true);
  assert.equal(quiet.committed, false);
});

test('the unattended wrapper never throws and always returns a line to show', async () => {
  const ok = await autoPublishWholesalePricing({ via: 'github', payload: PAYLOAD, putJson: async () => ({ noOp: false, commitSha: 'c', commitUrl: 'u' }) });
  assert.equal(ok.ok, true);
  assert.match(ok.line, /published \(1 products, via github\)/);

  const quiet = await autoPublishWholesalePricing({ via: 'github', payload: PAYLOAD, putJson: async () => ({ noOp: true }) });
  assert.equal(quiet.noOp, true);
  assert.match(quiet.line, /unchanged/);

  const failed = await autoPublishWholesalePricing({ via: 'github', payload: PAYLOAD, putJson: async () => { throw new Error('Bad credentials'); } });
  assert.equal(failed.ok, false);
  assert.match(failed.line, /publish failed \(Bad credentials\)\. Run wholesale_price_list_publish by hand\./);
});
