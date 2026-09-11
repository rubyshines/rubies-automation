/**
 * Admitting a company from the "New inbound" strip.
 *
 * The click used to wait on everything the admit did — company, contact, Gmail
 * threads, a Sonnet relationship summary — and answered only when all of it
 * was finished, which reads in the panel as a dead button. The split these
 * tests pin: the response goes out once the queue would read correctly, and
 * the rest runs after it.
 *
 * Stubs go into require.cache before the module under test is required, so
 * nothing here reaches Supabase, Gmail, Anthropic or Puppeteer.
 */
const test = require('node:test');
const assert = require('node:assert');

const calls = { addProspect: [], discover: [], summary: [], enrich: [], closed: 0 };
let addProspectResult = { id: 'blue-mountain-clinic', existed: false };
let discoverResult = { discovered: 2 };
let discoverError = null;
let releaseSummary;                       // resolves the background summary
let summaryGate = Promise.resolve();

function stub(modulePath, exports) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

stub('../../b2b-outreach/lib/addProspect', {
  slugify: (n) => String(n || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
  addProspect: async (_sb, args) => { calls.addProspect.push(args); return addProspectResult; },
});
stub('../../b2b-outreach/lib/manualSendReconcile', {
  discoverCompanyThreads: async (_sb, args) => {
    calls.discover.push(args);
    if (discoverError) throw new Error(discoverError);
    return discoverResult;
  },
});
stub('../../b2b-outreach/lib/relationshipSummary', {
  refreshCompanySummary: async (_sb, id) => { calls.summary.push(id); await summaryGate; },
});
stub('../../b2b-discovery/enrichOrgs', {
  fetchTargets: async (_sb, args) => [{ id: args.companyId, name: 'Blue Mountain Clinic', website: 'bluemountainclinic.org' }],
  enrichCompany: async (_sb, row) => { calls.enrich.push(row.id); return { status: 'located' }; },
});
stub('../../b2b-discovery/lib/scraper', { closePuppeteer: () => { calls.closed++; } });

const { admitInboundSender, finishAdmittedCompany } = require('../../b2b-outreach/lib/inboundTriage');

const sb = {}; // never touched — every path through these tests is stubbed

test.beforeEach(() => {
  calls.addProspect = []; calls.discover = []; calls.summary = []; calls.enrich = []; calls.closed = 0;
  addProspectResult = { id: 'blue-mountain-clinic', existed: false };
  discoverResult = { discovered: 2 };
  discoverError = null;
  summaryGate = new Promise((resolve) => { releaseSummary = resolve; });
});

test.afterEach(() => { if (releaseSummary) releaseSummary(); });

const CANDIDATE = {
  domain: 'bluemountainclinic.org', name: 'Blue Mountain Clinic',
  email: 'fearne@bluemountainclinic.org', contact_name: 'Fearne Perez',
  channel: 'lgbtq_org', country: 'United States', city: 'Missoula', region: 'Montana',
};

test('admit answers as soon as the company and its threads exist, with the rest still running', async () => {
  // summaryGate is unresolved for the whole of this test: if admit awaited the
  // background half, this await would never return and the test would time out.
  const res = await admitInboundSender(sb, { ...CANDIDATE });

  assert.equal(res.id, 'blue-mountain-clinic');
  assert.equal(res.threads_discovered, 2, 'the threads are in before the row reaches the queue');
  assert.equal(res.background, 'started', 'the client is told there is more coming');
  assert.equal(calls.summary.length, 1, 'the summary was kicked off, not awaited');
});

test('a location read off the message is carried into the company row', async () => {
  await admitInboundSender(sb, { ...CANDIDATE });
  const args = calls.addProspect[0];
  assert.equal(args.city, 'Missoula');
  assert.equal(args.region, 'Montana');
  assert.equal(args.country, 'United States');
  assert.equal(args.source, 'inbound_email');
  assert.equal(args.draft, false, 'someone who wrote to us never gets a cold intro draft');
});

test('a message that states no location still admits, leaving it to the background scrape', async () => {
  await admitInboundSender(sb, { domain: CANDIDATE.domain, name: CANDIDATE.name, email: CANDIDATE.email });
  const args = calls.addProspect[0];
  assert.equal(args.city, null);
  assert.equal(args.region, null);
});

test('a Gmail failure still admits the company and still schedules the background work', async () => {
  discoverError = 'gmail unavailable';
  const res = await admitInboundSender(sb, { ...CANDIDATE });

  assert.equal(res.id, 'blue-mountain-clinic');
  assert.match(res.warning, /thread import failed/);
  assert.equal(res.background, 'started', 'a location is still worth fetching when Gmail is down');
});

test('a lost company is surfaced without being re-opened or enriched', async () => {
  addProspectResult = { id: 'blue-mountain-clinic', existed: true, warning: 'already exists and is marked lost' };
  const res = await admitInboundSender(sb, { ...CANDIDATE });

  assert.equal(res.background, undefined, 'nothing was admitted, so nothing runs after it');
  assert.equal(calls.discover.length, 0);
  assert.equal(calls.summary.length, 0);
});

test('the background half writes the summary and the location, and closes the browser after', async () => {
  releaseSummary();
  const out = await finishAdmittedCompany(sb, 'blue-mountain-clinic');

  assert.equal(out.summary, true);
  assert.equal(out.enrich_status, 'located');
  assert.deepEqual(calls.enrich, ['blue-mountain-clinic']);
  assert.equal(calls.closed, 1, 'a one-off scrape must not leave Chromium alive in the server');
});

test('a summary that throws does not stop the location from being written', async () => {
  summaryGate = Promise.reject(new Error('anthropic 529'));
  summaryGate.catch(() => {});
  const out = await finishAdmittedCompany(sb, 'blue-mountain-clinic');

  assert.equal(out.summary, false);
  assert.equal(out.enrich_status, 'located', 'the two halves fail independently');
  assert.equal(calls.closed, 1);
});
