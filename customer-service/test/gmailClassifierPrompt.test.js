/**
 * Gmail classifier — the Tier-3 prompt is pure, so pin what the model is told.
 *
 * Regression (2026-09-06): a five-order customer answered our newsletter from
 * her work address. Headers showed an identifying domain and a corporate
 * signature, the model read "wholesale" at 0.55, and the B2B inbound strip
 * offered her employer as a prospect. Two things had to change: the prompt
 * names newsletter replies as customers, and the sender's order history is
 * rendered into the summary so the model has the one fact that settles it.
 */
const { test } = require('node:test');
const assert = require('node:assert');

const { buildClassifyPrompt } = require('../../gmail-management/lib/classifier');

const liz = {
  from_address: 'lizgayford@creativeoutdoor.com',
  from_name: 'Liz Gayford',
  to_addresses: ['hello@rubyshines.com'],
  subject: 'Re: Life Update From Jamie & Ruby',
  date: '2026-09-06T15:45:32+00:00',
  body_text: 'Congratulations!!!! Would love to hear about the university experience.\n\nLiz Gayford\nCOA Group of Companies\nDirector',
};
const stranger = { ...liz, from_address: 'buyer@someshop.com', from_name: 'A Buyer', subject: 'Stocking RUBIES' };

test('a sender with orders gets a "Sender on file" line; a stranger does not', () => {
  const history = new Map([['lizgayford@creativeoutdoor.com', { orders: 5, last_order_at: '2025-05-11T15:08:13+00:00' }]]);
  const prompt = buildClassifyPrompt([liz, stranger], history);
  assert.match(prompt, /\[0\] From: lizgayford@creativeoutdoor.com[\s\S]*?Sender on file: retail customer, 5 orders, last 2025-05/);
  const strangerBlock = prompt.slice(prompt.indexOf('[1] From:'));
  assert.doesNotMatch(strangerBlock, /Sender on file/);
});

test('history lookup is keyed case-insensitively and pluralizes correctly', () => {
  const history = new Map([['lizgayford@creativeoutdoor.com', { orders: 1, last_order_at: '2024-03-25T12:38:32+00:00' }]]);
  const prompt = buildClassifyPrompt([{ ...liz, from_address: 'LizGayford@CreativeOutdoor.com' }], history);
  assert.match(prompt, /Sender on file: retail customer, 1 order, last 2024-03/);
});

test('no history at all still builds the same prompt shape', () => {
  const prompt = buildClassifyPrompt([liz]);
  assert.match(prompt, /\[0\] From: lizgayford@creativeoutdoor.com/);
  assert.match(prompt, /Preview: Congratulations/);
  // The rules section explains the line, so only the emails section must be free of it.
  const emailsSection = prompt.slice(prompt.indexOf('\nEmails:'));
  assert.doesNotMatch(emailsSection, /Sender on file/);
});

test('the prompt tells the model that a reply to our own campaign is customer_support, and what the on-file line means', () => {
  const prompt = buildClassifyPrompt([liz]);
  assert.match(prompt, /reply to one of OUR marketing emails is a customer writing back/);
  assert.match(prompt, /Classify it customer_support, even when the signature names an employer/);
  assert.match(prompt, /never email_marketing/);
  assert.match(prompt, /"Sender on file: retail customer" means that address has placed retail orders/);
  // The older discriminations must still be there — this is an addition, not a rewrite.
  assert.match(prompt, /LGBTQ\+ organizations reaching out for the first time are NEVER spam/);
  assert.match(prompt, /wholesale means they want to BUY or STOCK our products/);
});
