const { describe, it } = require('node:test');
const assert = require('node:assert');

// The tool module pulls in systemFlags -> supabase. Stub the flag layer so
// these tests exercise the tool's own logic (guardrails, dispatch, rendering)
// without touching the network. Must be installed before the tool is required.
const flagsPath = require.resolve('../../shared/systemFlags');
let fakeFlag = null;
let lastSet = null;
require.cache[flagsPath] = {
  id: flagsPath,
  filename: flagsPath,
  loaded: true,
  exports: {
    async getFlag() { return fakeFlag; },
    async setFlag(key, enabled, note, expiresAt) {
      lastSet = { key, enabled, note, expiresAt };
      return true;
    },
    async isFlagEnabled() { return !!fakeFlag?.active; },
    isExpired() { return false; },
    _clearCache() {},
  },
};

const [awayTool] = require('../lib/tools/awayMode');
const call = (params) => awayTool.handler(params);
const textOf = (res) => res.content[0].text;

describe('away_mode tool — registration', () => {
  it('is registered in both tool surfaces (MCP server + operator agents)', () => {
    // The ad hoc console has its own registry; a tool present in only one is
    // the exact failure this feature could not afford (mobile is the use case).
    const server = require('fs').readFileSync(require.resolve('../server.js'), 'utf8');
    const operator = require('fs').readFileSync(require.resolve('../lib/operatorTools.js'), 'utf8');
    assert.match(server, /tools\/awayMode/);
    assert.match(operator, /tools\/awayMode/);
  });

  it('exposes an action-based schema', () => {
    assert.equal(awayTool.name, 'away_mode');
    assert.ok(awayTool.inputSchema.properties.action);
    assert.ok(awayTool.inputSchema.properties.until);
    assert.ok(awayTool.inputSchema.properties.back);
  });
});

describe('away_mode tool — enabling guardrails', () => {
  it('refuses to enable without an expiry', async () => {
    lastSet = null;
    const out = textOf(await call({ action: 'on', back: 'Sunday, August 9' }));
    assert.match(out, /Need `until`/);
    assert.equal(lastSet, null, 'must not write the flag');
  });

  it('refuses an unparseable expiry', async () => {
    lastSet = null;
    const out = textOf(await call({ action: 'on', until: 'next tuesday' }));
    assert.match(out, /Could not read/);
    assert.equal(lastSet, null);
  });

  it('refuses an expiry in the past', async () => {
    lastSet = null;
    const out = textOf(await call({ action: 'on', until: '2020-01-01 08:00' }));
    assert.match(out, /in the past/);
    assert.equal(lastSet, null);
  });

  it('enables with a future expiry, storing the return phrase', async () => {
    lastSet = null;
    const until = new Date(Date.now() + 86400000).toISOString();
    const out = textOf(await call({ action: 'on', until, back: 'Sunday, August 9' }));
    assert.equal(lastSet.key, 'cs_away_mode');
    assert.equal(lastSet.enabled, true);
    assert.equal(lastSet.note, 'Sunday, August 9');
    assert.equal(lastSet.expiresAt, until);
    assert.match(out, /switches itself off/);
    // Shows the actual email so it can be sanity-checked from a phone.
    assert.match(out, /out of town until Sunday, August 9/);
  });

  it('warns when enabled with no return phrase', async () => {
    const until = new Date(Date.now() + 86400000).toISOString();
    const out = textOf(await call({ action: 'on', until }));
    assert.match(out, /No `back` phrase/);
  });

  it('interprets a bare expiry as Eastern, not host local time', async () => {
    lastSet = null;
    await call({ action: 'on', until: '2099-08-10 08:00' });
    assert.equal(lastSet.expiresAt, '2099-08-10T12:00:00.000Z');
  });
});

describe('away_mode tool — off, status, preview', () => {
  it('off clears enabled, note and expiry together', async () => {
    lastSet = null;
    const out = textOf(await call({ action: 'off' }));
    assert.deepEqual(lastSet, { key: 'cs_away_mode', enabled: false, note: null, expiresAt: null });
    assert.match(out, /OFF/);
  });

  it('status reports ON with the self-off time and the live email', async () => {
    fakeFlag = {
      enabled: true, active: true, note: 'Sunday, August 9',
      expires_at: '2026-08-10T12:00:00Z',
    };
    const out = textOf(await call({ action: 'status' }));
    assert.match(out, /\*\*ON\*\*/);
    assert.match(out, /Aug 10, 2026, 8:00 AM ET/);
    assert.match(out, /out of town until Sunday, August 9/);
  });

  it('status distinguishes "never on" from "window already closed"', async () => {
    fakeFlag = { enabled: false, active: false, note: null, expires_at: null };
    assert.doesNotMatch(textOf(await call({ action: 'status' })), /window closed/);

    fakeFlag = { enabled: true, active: false, note: 'x', expires_at: '2026-08-10T12:00:00Z' };
    const closed = textOf(await call({ action: 'status' }));
    assert.match(closed, /OFF/);
    assert.match(closed, /window closed/);
  });

  it('reports the missing migration rather than a confusing OFF', async () => {
    fakeFlag = null;
    assert.match(textOf(await call({ action: 'status' })), /away-mode-schema\.sql/);
  });

  it('preview renders the email without writing anything', async () => {
    fakeFlag = null;
    lastSet = null;
    const out = textOf(await call({ action: 'preview', back: 'Monday, August 10' }));
    assert.match(out, /out of town until Monday, August 10/);
    assert.equal(lastSet, null, 'preview must not change state');
  });

  it('defaults to status when no action is given', async () => {
    fakeFlag = { enabled: false, active: false, note: null, expires_at: null };
    lastSet = null;
    assert.match(textOf(await call({})), /Away mode/);
    assert.equal(lastSet, null);
  });

  it('rejects an unknown action without writing', async () => {
    lastSet = null;
    assert.match(textOf(await call({ action: 'enable' })), /Unknown action/);
    assert.equal(lastSet, null);
  });
});
