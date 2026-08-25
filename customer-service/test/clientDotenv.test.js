/**
 * Static guard: every shared API client that reads process.env must load dotenv itself.
 *
 * A client that reads credentials out of process.env but never calls dotenv works fine
 * under the runners (server.js, cron entry points load dotenv first) and throws
 * "Missing <VAR> in .env" the moment anything requires it directly — an ad-hoc
 * scripts/_*.js analysis, a test, a node -e. Nothing else catches that: the module
 * loads, the suite passes, and the failure only shows up in a one-off script.
 *
 * Run: node --test customer-service/test/clientDotenv.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '../..');

// Client modules: anything in shared/ named *Client.js, plus the CS Shopify client,
// which lives outside shared/ because it is the Admin-API client rather than the
// ShopifyQL analytics one.
function clientModules() {
  const sharedDir = path.join(REPO_ROOT, 'shared');
  const shared = fs
    .readdirSync(sharedDir)
    .filter((f) => f.endsWith('Client.js'))
    .map((f) => path.join('shared', f));
  return [...shared, path.join('customer-service', 'lib', 'shopify.js')];
}

describe('client modules load their own env', () => {
  const modules = clientModules();

  // Self-check: a glob that silently matches nothing would keep this file green
  // forever while asserting about zero modules.
  it('finds the client modules it is meant to be guarding', () => {
    assert.ok(modules.length >= 8, `expected 8+ client modules, found ${modules.length}`);
    assert.ok(
      modules.includes(path.join('shared', 'supabaseClient.js')),
      'supabaseClient.js should be in the scanned set'
    );
    assert.ok(
      modules.includes(path.join('customer-service', 'lib', 'shopify.js')),
      'the CS Shopify client should be in the scanned set'
    );
  });

  for (const rel of modules) {
    it(`${rel} calls dotenv before reading process.env`, () => {
      const src = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
      if (!/process\.env/.test(src)) return; // reads no env — nothing to guard

      const dotenvAt = src.search(/require\(['"]dotenv['"]\)\.config\(/);
      assert.ok(dotenvAt !== -1, `${rel} reads process.env but never calls dotenv.config()`);

      const envAt = src.search(/process\.env/);
      assert.ok(
        dotenvAt < envAt,
        `${rel} reads process.env at index ${envAt} before dotenv.config() at ${dotenvAt}`
      );
    });
  }
});
