const test = require('node:test');
const assert = require('node:assert');

// Stub Gmail BEFORE requiring anything under test: settleThreadReadState and
// the sweep lazy-require the client, and a real getGmail would go looking for
// a token file.
const GMAIL_PATH = require.resolve('../../gmail-management/lib/gmailClient');
const gmailCalls = [];
const fakeGmail = {
  users: {
    threads: {
      modify: async (args) => { gmailCalls.push(['threads.modify', args]); return { data: {} }; },
      list: async ({ q, pageToken }) => {
        gmailCalls.push(['threads.list', { q, pageToken }]);
        return { data: { threads: fakeGmail._unread.map(id => ({ id })) } };
      },
    },
  },
  _unread: [],
};
require.cache[GMAIL_PATH] = {
  id: GMAIL_PATH, filename: GMAIL_PATH, loaded: true,
  exports: {
    getGmail: async () => fakeGmail,
    markThreadRead: async (gmail, id) => gmail.users.threads.modify({ userId: 'me', id, requestBody: { removeLabelIds: ['UNREAD'] } }),
  },
};

const { threadReadVerdict, gmailThreadReadVerdict, settleThreadReadState } = require('../../b2b-outreach/lib/readState');
const { reconcileReadState } = require('../../b2b-outreach/sync/reconcileReadState');

const OUT = (at, over = {}) => ({ direction: 'outbound', message_type: 'operator_message', sent_at: at, ...over });
const IN = (at, over = {}) => ({ direction: 'inbound', message_type: null, sent_at: at, ...over });

// ── the pure verdict ──────────────────────────────────────────────────────────

test('a thread we answered last is read', () => {
  const v = threadReadVerdict({ status: 'open', messages: [OUT('2026-09-08T14:00Z'), IN('2026-09-08T14:30Z'), OUT('2026-09-08T14:36Z')] });
  assert.strictEqual(v.read, true);
});

test('a person writing after our last reply keeps the thread unread', () => {
  const v = threadReadVerdict({ status: 'open', messages: [OUT('2026-09-08T13:22Z'), IN('2026-09-08T16:47Z')] });
  assert.strictEqual(v.read, false);
  assert.match(v.reason, /a person wrote/);
});

test('machine mail after our reply does not keep it unread', () => {
  for (const type of ['auto_reply', 'calendar_notice', 'bounce']) {
    const v = threadReadVerdict({ status: 'open', messages: [OUT('2026-09-08T14:38Z'), IN('2026-09-08T14:41Z', { message_type: type })] });
    assert.strictEqual(v.read, true, type);
  }
});

test('a human reply hiding behind machine mail is still a human reply', () => {
  const v = threadReadVerdict({ status: 'open', messages: [
    OUT('2026-09-08T14:38Z'), IN('2026-09-08T14:47Z'), IN('2026-09-08T14:48Z', { message_type: 'auto_reply' }),
  ] });
  assert.strictEqual(v.read, false);
});

test('a closed thread is read whatever it holds — closed is the operator or the closer saying done', () => {
  const v = threadReadVerdict({ status: 'closed', messages: [OUT('2026-09-08T14:00Z'), IN('2026-09-08T14:30Z')] });
  assert.strictEqual(v.read, true);
});

test('a thread of nothing but machine mail is read; an empty record is not', () => {
  assert.strictEqual(threadReadVerdict({ status: 'open', messages: [IN('2026-09-08T14:41Z', { message_type: 'auto_reply' })] }).read, true);
  assert.strictEqual(threadReadVerdict({ status: 'open', messages: [] }).read, false);
});

test('a manual Gmail reply counts as us answering', () => {
  const v = threadReadVerdict({ status: 'open', messages: [IN('2026-09-07T23:21Z'), OUT('2026-09-08T00:44Z', { message_type: null, source: 'manual_send' })] });
  assert.strictEqual(v.read, true);
});

test('message order is by sent_at, not array order', () => {
  const v = threadReadVerdict({ status: 'open', messages: [IN('2026-09-08T16:47Z'), OUT('2026-09-08T13:22Z')] });
  assert.strictEqual(v.read, false);
});

// ── the Gmail-thread verdict across shared threads ───────────────────────────

function makeSb({ threads = [], messages = [] } = {}) {
  return {
    from(table) {
      const q = { _f: {} };
      q.select = () => q;
      q.eq = (col, val) => { q._f[col] = val; return q; };
      q.then = (resolve) => {
        const rows = table === 'b2b_threads'
          ? threads.filter(t => t.gmail_thread_id === q._f.gmail_thread_id)
          : messages.filter(m => m.gmail_thread_id === q._f.gmail_thread_id);
        return resolve({ data: rows, error: null });
      };
      return q;
    },
  };
}

test('a shared Gmail thread is read only when every owner is settled', async () => {
  const sb = makeSb({
    threads: [
      { id: 1, company_id: 'org-a', status: 'open', gmail_thread_id: 'g1' },
      { id: 2, company_id: 'org-b', status: 'open', gmail_thread_id: 'g1' },
    ],
    messages: [
      { thread_id: 1, gmail_thread_id: 'g1', ...OUT('2026-09-08T14:00Z') },
      { thread_id: 2, gmail_thread_id: 'g1', ...OUT('2026-09-08T14:00Z') },
      { thread_id: 2, gmail_thread_id: 'g1', ...IN('2026-09-08T15:00Z') },
    ],
  });
  const v = await gmailThreadReadVerdict(sb, 'g1');
  assert.strictEqual(v.known, true);
  assert.strictEqual(v.read, false, "org-b's reply must keep the shared thread unread");
  assert.match(v.reason, /org-b/);
});

test('a thread the engine has no record of is unknown, never read', async () => {
  const v = await gmailThreadReadVerdict(makeSb(), 'nothing');
  assert.strictEqual(v.known, false);
  assert.strictEqual(v.read, false);
});

// ── settle: the live hook ─────────────────────────────────────────────────────

test('settle clears UNREAD on the Gmail thread when the verdict is read', async () => {
  gmailCalls.length = 0;
  const sb = makeSb({
    threads: [{ id: 1, company_id: 'org-a', status: 'open', gmail_thread_id: 'g1' }],
    messages: [{ thread_id: 1, gmail_thread_id: 'g1', ...IN('2026-09-08T14:00Z') }, { thread_id: 1, gmail_thread_id: 'g1', ...OUT('2026-09-08T14:30Z') }],
  });
  const r = await settleThreadReadState({ sb, gmail_thread_id: 'g1' });
  assert.strictEqual(r.marked, true);
  assert.deepStrictEqual(gmailCalls, [['threads.modify', { userId: 'me', id: 'g1', requestBody: { removeLabelIds: ['UNREAD'] } }]]);
});

test('settle leaves a thread with a waiting reply alone and never touches Gmail', async () => {
  gmailCalls.length = 0;
  const sb = makeSb({
    threads: [{ id: 1, company_id: 'org-a', status: 'open', gmail_thread_id: 'g1' }],
    messages: [{ thread_id: 1, gmail_thread_id: 'g1', ...OUT('2026-09-08T13:22Z') }, { thread_id: 1, gmail_thread_id: 'g1', ...IN('2026-09-08T16:47Z') }],
  });
  const r = await settleThreadReadState({ sb, gmail_thread_id: 'g1' });
  assert.strictEqual(r.marked, false);
  assert.strictEqual(gmailCalls.length, 0);
});

test('settle is fail-soft: a Gmail error is reported, not thrown', async () => {
  const sb = makeSb({
    threads: [{ id: 1, company_id: 'org-a', status: 'closed', gmail_thread_id: 'g1' }],
  });
  const broken = { users: { threads: { modify: async () => { throw new Error('backend 503'); } } } };
  const r = await settleThreadReadState({ sb, gmail: broken, gmail_thread_id: 'g1' });
  assert.strictEqual(r.marked, false);
  assert.match(r.error, /503/);
});

// ── the sweep ─────────────────────────────────────────────────────────────────

test('the sweep settles what the verdict says is read, leaves waiting replies, and counts non-outreach mail', async () => {
  gmailCalls.length = 0;
  fakeGmail._unread = ['answered', 'waiting', 'github'];
  const sb = makeSb({
    threads: [
      { id: 1, company_id: 'seed', status: 'open', gmail_thread_id: 'answered' },
      { id: 2, company_id: 'uniting', status: 'open', gmail_thread_id: 'waiting' },
    ],
    messages: [
      { thread_id: 1, gmail_thread_id: 'answered', ...IN('2026-09-08T14:31Z') },
      { thread_id: 1, gmail_thread_id: 'answered', ...OUT('2026-09-08T14:36Z') },
      { thread_id: 2, gmail_thread_id: 'waiting', ...OUT('2026-09-08T13:22Z') },
      { thread_id: 2, gmail_thread_id: 'waiting', ...IN('2026-09-08T16:47Z') },
    ],
  });
  const r = await reconcileReadState({ sb, gmail: fakeGmail, apply: true });
  assert.strictEqual(r.scanned, 3);
  assert.deepStrictEqual(r.settled.map(s => s.gmail_thread_id), ['answered']);
  assert.deepStrictEqual(r.left.map(l => l.gmail_thread_id), ['waiting']);
  assert.strictEqual(r.unknown, 1, 'the GitHub notification is not ours to touch');
  const modified = gmailCalls.filter(c => c[0] === 'threads.modify').map(c => c[1].id);
  assert.deepStrictEqual(modified, ['answered']);
});

test('a dry run reports the same verdicts and writes nothing', async () => {
  gmailCalls.length = 0;
  fakeGmail._unread = ['answered'];
  const sb = makeSb({
    threads: [{ id: 1, company_id: 'seed', status: 'closed', gmail_thread_id: 'answered' }],
  });
  const r = await reconcileReadState({ sb, gmail: fakeGmail, apply: false });
  assert.strictEqual(r.settled.length, 1);
  assert.strictEqual(r.settled[0].dry_run, true);
  assert.strictEqual(gmailCalls.filter(c => c[0] === 'threads.modify').length, 0);
});
