/**
 * Gmail CS intake: a reply on a thread Jamie answered from his own Gmail is
 * labelled but never archived.
 *
 * 2026-09-01: two customers replied to an address-confirmation email Jamie had
 * sent from jamie@. Intake classified both as customer support, matched the
 * thread as "legacy — already handled in Gmail", and archived them out of the
 * inbox within 20 seconds. Nobody read them for a week. The skip is right (the
 * reply is Jamie's to answer, not Gorgias's); the archive is not.
 *
 * Run: node --test customer-service/test/gmailCsLegacyThread.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// processGmailCs pulls the Gmail, Gorgias and ticket-intake clients at load.
// None are needed for the pure rule under test; stub them so the module loads
// without credentials or a network.
function stub(relPath, exports) {
  const p = require.resolve(relPath);
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
}
stub('../../gmail-management/lib/gmailClient', {});
stub('../../gmail-management/lib/gmailSync', {});
stub('../import/gorgiasClient', {});
stub('../intake/processGorgiasTickets', {});

const { archivesOnSkip, SKIP_REASONS_KEPT_IN_INBOX } = require('../intake/processGmailCs');

describe('archivesOnSkip', () => {
  it('a legacy-thread reply is never archived, even with archiving on', () => {
    assert.equal(archivesOnSkip('legacy_thread', true), false);
    assert.equal(archivesOnSkip('legacy_thread', false), false);
  });

  it('mail already living in Gorgias is archived when archiving is on', () => {
    for (const reason of ['addressed_to_care', 'already_forwarded', 'gorgias_already_handling', 'duplicate']) {
      assert.equal(archivesOnSkip(reason, true), true, reason);
    }
  });

  it('nothing is archived while the archive rollout flag is off', () => {
    for (const reason of ['addressed_to_care', 'duplicate', 'legacy_thread']) {
      assert.equal(archivesOnSkip(reason, false), false, reason);
    }
  });

  it('the kept-in-inbox set is exactly the legacy-thread reason', () => {
    assert.deepEqual([...SKIP_REASONS_KEPT_IN_INBOX], ['legacy_thread']);
  });
});
