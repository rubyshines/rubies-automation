const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { publishThemeAsset, lastLine } = require('../lib/themeAssetPublish');

function tmpAssetPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'theme-asset-test-'));
  fs.mkdirSync(path.join(dir, 'assets'));
  return path.join(dir, 'assets', 'thing.json');
}

const OPTS = {
  relativeOutPath: path.join('assets', 'thing.json'),
  branchPrefix: 'data/thing',
  commitTitle: 'data: thing',
  commitBody: 'body',
  prTitle: 'thing',
  prBody: 'body',
};

test('dry_run writes the payload into the theme working tree', async () => {
  const outPath = tmpAssetPath();
  const result = await publishThemeAsset([{ name: 'A' }], { outPath, dry_run: true, ...OPTS });

  assert.strictEqual(result.dryRun, true);
  assert.strictEqual(result.path, outPath);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(outPath, 'utf8')), [{ name: 'A' }]);
});

test('a real publish never writes the theme working tree', async () => {
  // The commit comes from an isolated worktree, so the theme's own checkout must
  // be left clean. Not-a-git-repo makes the worktree step throw immediately —
  // what matters is that outPath was never touched on the way there.
  const outPath = tmpAssetPath();

  await assert.rejects(
    publishThemeAsset([{ name: 'A' }], { outPath, dry_run: false, ...OPTS }),
    /Not a git repo/
  );
  assert.strictEqual(fs.existsSync(outPath), false, 'publish must not dirty the theme checkout');
});

test('publish still validates that the theme assets dir exists', async () => {
  await assert.rejects(
    publishThemeAsset([], { outPath: '/nope/does/not/exist/assets/thing.json', dry_run: true, ...OPTS }),
    /Theme assets dir does not exist/
  );
});

test('lastLine reports the final non-empty line of a trailing-newline error', () => {
  assert.strictEqual(lastLine('failed to run git\nfatal: cannot switch branch\n'), 'fatal: cannot switch branch');
  assert.strictEqual(lastLine('\n\n'), 'no detail reported');
  assert.strictEqual(lastLine(undefined), 'no detail reported');
});
