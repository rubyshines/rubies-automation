const { test } = require('node:test');
const assert = require('node:assert');
const { buildRawMessage } = require('../../gmail-management/lib/gmailClient');

test('buildRawMessage: headers, multipart, and base64 attachment', () => {
  const content = Buffer.from('hello-xlsx-bytes');
  const mime = buildRawMessage({
    to: 'kali.lin@qq.com',
    subject: 'New Production Order - Kali',
    bodyText: 'Hi Kali,\n\nPlease find attached.',
    attachment: { filename: 'order.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', content },
  });
  assert.match(mime, /^To: kali\.lin@qq\.com\r\n/m);
  assert.match(mime, /Subject: New Production Order - Kali/);
  assert.match(mime, /Content-Type: multipart\/mixed; boundary="rubies_/);
  assert.match(mime, /Content-Disposition: attachment; filename="order\.xlsx"/);
  assert.match(mime, /Content-Transfer-Encoding: base64/);
  // attachment body is the base64 of the content
  assert.ok(mime.includes(content.toString('base64')));
  // CRLF line endings + closing boundary
  assert.ok(mime.includes('\r\n'));
  assert.match(mime, /--rubies_[0-9a-f]+--$/);
});

test('buildRawMessage: works without an attachment', () => {
  const mime = buildRawMessage({ to: 'a@b.com', subject: 'Hi', bodyText: 'body' });
  assert.match(mime, /To: a@b\.com/);
  assert.ok(!/Content-Disposition: attachment/.test(mime));
});
