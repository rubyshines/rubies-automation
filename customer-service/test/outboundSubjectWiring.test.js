/**
 * Static wiring for the outbound-draft subject line.
 *
 * The subject of an outreach we initiate lives only in
 * cs_ai_drafts.structured_output.subject. Before this box existed it was
 * invisible in the dashboard and uneditable, so the customer received whatever
 * the composer chose. Four pieces have to agree for the operator to see and
 * change it, and none of them is reachable by a runtime test: the server has
 * to project the subject onto the active draft, the page has to have the
 * input, the client has to render it and put it on the send payload, and the
 * execute-and-send path has to pass it through. This pins the seams.
 *
 * Run: node --test customer-service/test/outboundSubjectWiring.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const DASH = path.join(__dirname, '..', 'dashboard');
const read = (p) => fs.readFileSync(path.join(DASH, p), 'utf8');

describe('outbound draft subject — wiring', () => {
  it('server projects structured_output.subject onto the active draft', () => {
    const server = read('server.js');
    assert.match(server, /subject:structured_output->>subject/);
  });

  it('server lets an operator-edited subject win on an outbound send and passes it through execute-and-send', () => {
    const server = read('server.js');
    assert.match(server, /const editedSubject = typeof body\.subject === 'string'/);
    assert.match(server, /sendDraft: \(\) => apiSendDraft\(draftId, \{\s*response: body\.response,\s*subject: body\.subject,/);
  });

  it('page has the subject input and it starts hidden', () => {
    const html = read(path.join('public', 'index.html'));
    assert.match(html, /<input[^>]*id="draft-subject"[^>]*hidden>/);
  });

  it('client renders the subject for the open ticket and sends it on both send paths', () => {
    const app = read(path.join('public', 'app.js'));
    assert.match(app, /function renderDraftSubject\(ticket, draft\)/);
    assert.match(app, /function getDraftSubjectPayload\(\)/);
    // Only tickets we initiated own a subject; an inbound reply threads on the customer's.
    assert.match(app, /ticket\?\.initiated_by === 'operator'/);
    const sendPaths = app.match(/\.\.\.getDraftSubjectPayload\(\)/g) || [];
    assert.equal(sendPaths.length, 2, 'send and execute-and-send both carry the subject');
    assert.match(app, /\/api\/drafts\/\$\{draftId\}\/execute-and-send/);
  });
});
