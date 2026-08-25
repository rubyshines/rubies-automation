/**
 * The queue tombstone: which tab it applies to.
 *
 * The regression this exists for, found in production within hours of the Bug
 * tab shipping: flag a draft as a bug, then answer the customer by hand and
 * send. The send tombstones the ticket so it leaves New — correct — but the
 * tombstone was GLOBAL, so switching to the Bug tab showed a count with an empty
 * list under it. Worse than a plain miss: the server count and the rendered list
 * disagreed, so the one surface built to stop a bug being forgotten was the
 * surface hiding it.
 *
 * The root cause is a category error, which is why the fix is a scope and not a
 * special case. A tombstone means "gone from the work cycle". The Bug tab is not
 * a work cycle, and flag-then-send-by-hand is its single most common entry path,
 * so the ticket it filtered out was always going to be the one that mattered.
 *
 * This logic previously lived inline in loadTicketQueue with no harness, which
 * is why it shipped wrong — same reason intakeParse.js was extracted.
 *
 * Run: node --test customer-service/test/queueSuppression.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  CYCLING_TABS,
  suppressionAppliesTo,
  filterSuppressed,
  idsToUnsuppress,
} = require('../dashboard/public/queueSuppression');

const TICKETS = [
  { id: 1, status: 'open' },
  { id: 2, status: 'closed' },
  { id: 3, status: 'pending_operator' },
];
const suppressed = (...ids) => new Map(ids.map(id => [id, Date.now() + 90_000]));

describe('suppressionAppliesTo', () => {
  it('covers every queue an operator cycles through', () => {
    for (const tab of ['new', 'followup', 'onme', 'parked', 'snoozed']) {
      assert.equal(suppressionAppliesTo(tab), true, `${tab} is a work cycle`);
    }
  });

  it('does NOT cover Bug — a ticket you just actioned is what belongs there', () => {
    assert.equal(suppressionAppliesTo('bug'), false);
  });

  it('does NOT cover Closed — "I just closed it" is the reason it is in the list', () => {
    assert.equal(suppressionAppliesTo('closed'), false);
  });
});

describe('filterSuppressed', () => {
  it('hides a just-actioned ticket from the cycling queue it left', () => {
    const visible = filterSuppressed(TICKETS, 'new', suppressed(1));
    assert.deepEqual(visible.map(t => t.id), [2, 3]);
  });

  it('shows it on the Bug tab — the shipped regression', () => {
    // Flagged as a bug, then answered by hand and sent. The send tombstones it.
    const visible = filterSuppressed(TICKETS, 'bug', suppressed(1));
    assert.deepEqual(visible.map(t => t.id), [1, 2, 3],
      'a bug you just answered must not vanish from the one list that remembers it');
  });

  it('shows it on Closed too', () => {
    assert.equal(filterSuppressed(TICKETS, 'closed', suppressed(2)).length, 3);
  });

  it('passes the list through untouched when nothing is suppressed', () => {
    assert.equal(filterSuppressed(TICKETS, 'new', new Map()), TICKETS);
    assert.equal(filterSuppressed(TICKETS, 'new', null), TICKETS);
  });
});

describe('idsToUnsuppress', () => {
  it('releases a tombstone once the cycling queue stops returning it', () => {
    // Ticket 9 was actioned and the status flip has landed — New no longer lists it.
    assert.deepEqual(idsToUnsuppress(TICKETS, 'new', suppressed(9)), [9]);
  });

  it('keeps suppressing while the snapshot still lags', () => {
    assert.deepEqual(idsToUnsuppress(TICKETS, 'new', suppressed(1)), []);
  });

  it('releases nothing while off a cycling tab', () => {
    // Absence from the Bug tab says nothing about whether a New tombstone's flip
    // landed. Reconciling here would resurrect just-actioned tickets into the
    // cycle simply because someone opened a different tab.
    assert.deepEqual(idsToUnsuppress(TICKETS, 'bug', suppressed(9)), []);
    assert.deepEqual(idsToUnsuppress(TICKETS, 'closed', suppressed(9)), []);
  });
});

describe('browser wiring', () => {
  // app.js reads window.queueSuppression, so the module has to attach itself and
  // index.html has to load it. Neither is checked by anything that runs.
  it('attaches to the global when there is no module system', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, '../dashboard/public/queueSuppression.js'), 'utf8');
    const root = {};
    new Function('module', 'self', src)(undefined, root);
    assert.equal(typeof root.queueSuppression.filterSuppressed, 'function');
  });

  it('is loaded by index.html before app.js', () => {
    const fs = require('fs');
    const path = require('path');
    const html = fs.readFileSync(path.join(__dirname, '../dashboard/public/index.html'), 'utf8');
    const mod = html.indexOf('queueSuppression.js');
    const app = html.indexOf('app.js');
    assert.ok(mod !== -1, 'index.html must load queueSuppression.js');
    assert.ok(mod < app, 'it has to be parsed before app.js references it');
  });

  it('app.js calls it instead of re-answering the question inline', () => {
    const fs = require('fs');
    const path = require('path');
    const app = fs.readFileSync(path.join(__dirname, '../dashboard/public/app.js'), 'utf8');
    assert.ok(app.includes('queueSuppression.filterSuppressed'));
    assert.ok(app.includes('queueSuppression.idsToUnsuppress'));
    assert.ok(!/tickets\.filter\(t => !_suppressedTicketIds\.has/.test(app),
      'the inline copy is what shipped the bug — it must not come back');
  });

  it('the guards can see something', () => {
    assert.ok(CYCLING_TABS.length >= 5, 'an empty tab list would make every assertion above vacuous');
  });
});
