'use strict';
/**
 * Every email the Virtual Closet sends, composed here (wireframes 1z, 1aa,
 * 1ab, 1ac, 1ad). Sent through SendGrid from care@rubyshines.com. When
 * SendGrid is not configured (local dev) the email is printed to the console
 * with its links, so flows can be walked without a mailbox.
 */
const { sendEmail } = require('../../shared/sendgridClient');
const { esc } = require('../views/layout');
const { dollars } = require('./money');

const BASE = process.env.VC_BASE_URL || `http://localhost:${process.env.PORT || 3850}`;
const OPS_BASE = process.env.VC_OPS_BASE_URL || 'https://ops.rubyshines.com';
const OPERATOR_EMAIL = process.env.VC_OPERATOR_EMAIL || process.env.ALLOWED_EMAIL || 'jamie@rubyshines.com';
const FROM = { fromName: 'RUBIES', fromEmail: 'care@rubyshines.com' };

function layout(title, inner, footerLinks = '') {
  return `<!doctype html><html><body style="margin:0;background:#f6f6f6;font-family:system-ui,-apple-system,Segoe UI,sans-serif;color:#222">
<div style="max-width:560px;margin:0 auto;padding:24px 16px">
<div style="font-weight:800;letter-spacing:.12em;margin-bottom:16px">RUBIES</div>
<div style="background:#fff;border:1px solid #ddd;padding:24px">
<h1 style="font-size:20px;margin:0 0 12px">${esc(title)}</h1>
${inner}
</div>
<p style="font-size:12px;color:#666;margin-top:14px">${footerLinks || `RUBIES · care@rubyshines.com`}</p>
</div></body></html>`;
}
const p = t => `<p style="margin:0 0 12px;line-height:1.5">${t}</p>`;
const btn = (href, label) => `<p style="margin:16px 0"><a href="${href}" style="display:inline-block;background:#222;color:#fff;text-decoration:none;padding:10px 18px;font-weight:700">${esc(label)}</a></p>`;
const btns = pairs => `<p style="margin:16px 0">${pairs.map(([href, label]) => `<a href="${href}" style="display:inline-block;background:#222;color:#fff;text-decoration:none;padding:10px 18px;font-weight:700;margin-right:8px">${esc(label)}</a>`).join('')}</p>`;
const itemsList = items => (items || []).map(i => `${esc(i.styleName || i.style)} · ${esc(i.colour)} · ${esc(i.size)}`).join(' and ');

async function deliver({ to, subject, html, text, tag }) {
  if (!process.env.SENDGRID_API_KEY || process.env.VC_EMAIL_MODE === 'console') {
    const links = [...html.matchAll(/href="([^"]+)"/g)].map(m => m[1]).filter(u => !u.startsWith('mailto:'));
    console.log(`\n[vc email → ${to}] ${subject}\n  ${(text || '').split('\n').filter(Boolean).slice(0, 3).join('\n  ')}\n  links: ${links.join('\n         ')}\n`);
    return { ok: true, console: true };
  }
  const r = await sendEmail({ to, subject, html, text: text || undefined, ...FROM });
  if (!r.ok) console.warn(`[vc email] ${tag || subject} to ${to} failed: ${r.error}`);
  return r;
}

const link = path => `${BASE}${path}`;

// ---- account emails (1ab) ---------------------------------------------------
async function verifyEmail({ user, token, centre }) {
  const url = link(`/verify/${token}`);
  return deliver({ to: user.email, subject: `Verify your email for ${centre.name}`, tag: 'verify',
    text: `One tap to finish setting up ${centre.name}. ${url}`,
    html: layout('Verify your email', p(`Required: one tap to finish setting up ${esc(centre.name)}. Nothing works until you do.`) + btn(url, 'Verify') + p(`<span style="color:#666">Didn't ask for this? Ignore it.</span>`)) });
}
async function resetPassword({ user, token }) {
  const url = link(`/reset/${token}`);
  return deliver({ to: user.email, subject: 'Reset your password', tag: 'reset',
    text: `Choose a new password: ${url}`,
    html: layout('Reset your password', p('Link good for 24 hours. Didn\'t ask? Ignore this.') + btn(url, 'Choose a new password')) });
}
async function invitation({ email, token, centre, invitedBy, expiresAt }) {
  const url = link(`/invite/${token}`);
  return deliver({ to: email, subject: `${invitedBy} invited you to join ${centre.name}`, tag: 'invite',
    text: `Help run the closet: ${url}`,
    html: layout(`${esc(invitedBy)} invited you to join ${esc(centre.name)}`, p('Help run the closet: see requests, send boxes and share the link.') + btn(url, 'Accept') + p(`<span style="color:#666">Expires ${new Date(expiresAt).toLocaleDateString('en-US', { month: 'long', day: 'numeric' })}.</span>`)) });
}
async function addedToCentre({ user, centre }) {
  return deliver({ to: user.email, subject: `You were added to ${centre.name}`, tag: 'added',
    text: `Open your private view: ${link('/home')}`,
    html: layout(`You were added to ${esc(centre.name)} as a member`, btn(link('/home'), 'Open your private view')) });
}
async function madeAdmin({ user, centre, by }) {
  return deliver({ to: user.email, subject: `You're now an admin of ${centre.name}`, tag: 'admin',
    text: `${by} handed it over. ${link('/home')}`,
    html: layout(`You're now an admin of ${esc(centre.name)}`, p(`${esc(by)} handed it over. You can change settings, invite people and leave the programme.`) + btn(link('/home'), 'Open')) });
}
async function emailChanged({ oldEmail, newEmail }) {
  return deliver({ to: oldEmail, subject: 'Your email was changed', tag: 'email-changed',
    text: `Your email was changed to ${newEmail}. Wasn't you? Reply to this email.`,
    html: layout('Your email was changed', p(`Your email was changed to <b>${esc(newEmail)}</b>. Wasn't you? <a href="mailto:care@rubyshines.com">Tell us</a>.`)) });
}
async function confirmEmailChange({ newEmail, token }) {
  const url = link(`/account/email/${token}`);
  return deliver({ to: newEmail, subject: 'Confirm your new email', tag: 'email-change',
    text: `Confirm: ${url}`, html: layout('Confirm your new email', p('Tap to move your account to this address. The old one works until you do.') + btn(url, 'Confirm')) });
}

// ---- operator emails (1z) ---------------------------------------------------
async function operatorSignup({ centre, user }) {
  const q = `${OPS_BASE}/closets#centre-${centre.id}`;
  const prog = [centre.programmes?.closet && 'Virtual Closet', centre.programmes?.pass_it_on && 'Pass It On'].filter(Boolean).join(', ');
  return deliver({ to: OPERATOR_EMAIL, subject: `A centre signed up: ${centre.name}`, tag: 'op-signup',
    text: `${centre.name} · ${centre.website || ''} · ${prog} · admin ${user.name || ''} ${user.email}. Review: ${q}`,
    html: layout(`A centre signed up: ${esc(centre.name)}`,
      p(`<b>${esc(centre.name)}</b>${centre.address?.city ? `, ${esc(centre.address.city)}` : ''}${centre.website ? ` · <a href="${esc(centre.website)}">${esc(centre.website)}</a>` : ''}`) +
      p(`Ticked: ${esc(prog || 'nothing')}<br>Sizes: ${esc((centre.sizes || []).join(', '))}${centre.kids_sizes ? ', kids' : ''}<br>Admin: ${esc(user.name || '')}${user.role_title ? `, ${esc(user.role_title)}` : ''}, ${esc(user.email)} ✓ verified`) +
      btns([[q, 'Approve'], [q, 'Ask for more'], [q, 'Decline']]) + p('<span style="color:#666">Buttons open the queue in Operations.</span>')) });
}
async function operatorNeedsAttention({ items }) {
  if (!items.length) return { ok: true, skipped: true };
  return deliver({ to: OPERATOR_EMAIL, subject: `Needs attention · ${items.length} thing${items.length === 1 ? '' : 's'}`, tag: 'op-attention',
    text: items.map(i => `- ${i.text}`).join('\n'),
    html: layout(`Needs attention · ${items.length}`, `<ul style="padding-left:18px">${items.map(i => `<li style="margin-bottom:8px">${esc(i.text)} <a href="${OPS_BASE}/closets${i.anchor || ''}">Open</a></li>`).join('')}</ul>`) });
}

// ---- centre programme emails (1aa) -----------------------------------------
function settingsLine(centre) {
  return `Sizes ${esc((centre.sizes || []).join(', '))}${centre.kids_sizes ? ', kids' : ''} · ${centre.items_per_request} items per request · ${centre.requests_per_year} requests a person a year · goal ${dollars(centre.goal_cents)} · ${centre.approval_mode === 'by_hand' ? 'approval by hand' : 'automatic approval'} · shipping to a door ${centre.ship_to_door ? 'on' : 'off'}`;
}
const STORE = 'https://rubyshines.com';
const handy = `Handy to pass on: <a href="${STORE}/pages/how-it-works">How RUBIES works</a> · <a href="${STORE}/collections/all">Our styles</a> · <a href="${STORE}/pages/size-guide">Size guide</a> · <a href="${BASE}/free-pair-terms">Free pair terms</a>`;

async function welcome({ centre, to }) {
  const url = `${BASE}/${centre.slug}`;
  return deliver({ to, subject: `Welcome, ${centre.name}. Your closet is open.`, tag: 'welcome',
    text: `Your page is live: ${url}. Private view: ${BASE}/home`,
    html: layout(`Welcome, ${esc(centre.name)}. Your closet is open.`,
      p(`Hi, your page is live${centre.programmes?.pass_it_on ? ' and you\'re on the donation map' : ''}. This is the one email to forward to whoever runs the closet after you.`) +
      p(`<b>Your link</b><br><a href="${url}">${esc(url.replace(/^https?:\/\//, ''))}</a><br>Everyone from it gets 20% off one order. Share it on your site, socials and noticeboard. Ready-made post and QR: in your <a href="${BASE}/home">private view</a>.`) +
      p(`<b>How it works, in five lines</b><br>Shopping, requesting and sponsoring all land in one box. RUBIES matches every dollar. Requests are approved ${centre.approval_mode === 'by_hand' ? 'by you from an email' : 'automatically within your limits'}. At ${dollars(centre.goal_cents)} we email you to send it. It arrives at your address with everyone's items inside.`) +
      p(`<b>Your settings</b><br>${settingsLine(centre)}. <a href="${BASE}/settings">Change any of these</a>.`) +
      p(handy) + btn(`${BASE}/home`, 'Open your private view') +
      p(`Questions, any time: Jamie, <a href="mailto:jamie@rubyshines.com">jamie@rubyshines.com</a>.`)) });
}
async function sponsored({ centre, to, amountCents, box, raised, goal }) {
  return deliver({ to, subject: 'Someone sponsored your closet', tag: 'sponsored',
    text: `A sponsor put ${dollars(amountCents)} into box #${box.number}. Box #${box.number}: ${dollars(raised)} raised of ${dollars(goal)}.`,
    html: layout('Someone sponsored your closet', p(`A sponsor put <b>${dollars(amountCents)}</b> into box #${box.number}. RUBIES matches it when the box ships.`) + p(`Box #${box.number}: ${dollars(raised)} raised of ${dollars(goal)}`) + btn(`${BASE}/home`, 'See the box')) });
}
async function requestNeedsAnswer({ centre, to, request, items, approveToken, declineToken }) {
  const a = link(`/answer/${approveToken}`), d = link(`/answer/${declineToken}`);
  return deliver({ to, subject: 'A free pair was requested · approve by hand', tag: 'needs-answer',
    text: `${request.name} requested ${itemsList(items)}, ${request.delivery === 'ship' ? 'shipped to them' : 'to pick up at the centre'}. Approve: ${a} Decline: ${d}`,
    html: layout('A free pair was requested', p(`<b>${esc(request.name)}</b> requested ${itemsList(items)}, ${request.delivery === 'ship' ? 'shipped to them ($15 from the box)' : 'to pick up at the centre'}.`) + (request.words ? p(`“${esc(request.words)}”`) : '') + btns([[a, 'Approve'], [d, 'Decline']]) + p('<span style="color:#666">One tap, no sign-in. Links expire after 14 days; then it needs your answer in the private view.</span>')) });
}
async function requestAutoApproved({ centre, to, request, items, box, count }) {
  return deliver({ to, subject: `A request joined box #${box.number}`, tag: 'auto-approved',
    text: `${request.name} requested ${items.length} item(s), approved within your limits. Box #${box.number} now has ${count} requests.`,
    html: layout(`A request joined box #${box.number}`, p(`${esc(request.name)} requested ${items.length} item${items.length === 1 ? '' : 's'}, approved within your limits. Box #${box.number} now has ${count} request${count === 1 ? '' : 's'}. <a href="${BASE}/home">See them</a>.`)) });
}
async function boxFunded({ centre, to, box, raised }) {
  return deliver({ to, subject: `Box #${box.number} is funded`, tag: 'funded',
    text: `${dollars(raised)} raised. Fill and send: ${BASE}/send`,
    html: layout(`Box #${box.number} is funded`, p(`${dollars(raised)} raised. RUBIES matches it when it ships. Requested items are set; you fill the rest or let it fill itself.`) + btns([[`${BASE}/send`, 'Fill and send the box'], [`${BASE}/home`, 'Keep it growing']]) + p('<span style="color:#666">New requests now wait for the next box until you send this one.</span>')) });
}
async function boxOnItsWay({ centre, to, box, items, requesters, nextBox }) {
  return deliver({ to, subject: `Box #${box.number} is on its way`, tag: 'box-shipped',
    text: `${items} items to your address. ${box.carrier || ''} ${box.tracking_number || ''}`,
    html: layout(`Box #${box.number} is on its way`, p(`${items} items to your address. ${esc(box.carrier || '')} ${esc(box.tracking_number || '')}`) + p(`Inside: ${requesters.length} request${requesters.length === 1 ? '' : 's'}${requesters.length ? ` (${requesters.map(esc).join(', ')})` : ''} and the rest across your sizes. <a href="${BASE}/history">Packing list</a>`) + (nextBox ? p(`Box #${nextBox.number} is open.`) : '')) });
}
async function boxArrived({ centre, to, box, pickups }) {
  return deliver({ to, subject: `Box #${box.number} arrived`, tag: 'box-arrived',
    text: `Box #${box.number} arrived; ${pickups} people were told it's ready.`,
    html: layout(`Box #${box.number} arrived`, p(`${pickups} ${pickups === 1 ? 'person was' : 'people were'} told it's ready to collect. Nothing to do.`) + btn(`${BASE}/home`, 'Open your private view')) });
}
async function statement({ centre, to, month, stats }) {
  const rows = Object.entries(stats).map(([k, v]) => `<tr><td style="padding:4px 8px;color:#666">${esc(k)}</td><td style="padding:4px 8px;font-weight:700">${esc(String(v))}</td></tr>`).join('');
  return deliver({ to, subject: `Your ${month} statement`, tag: 'statement',
    text: Object.entries(stats).map(([k, v]) => `${k}: ${v}`).join('\n'),
    html: layout(`Your ${esc(month)} statement`, `<table>${rows}</table>` + btn(`${BASE}/history`, 'History')) });
}
async function byHandReminder({ centre, to, count }) {
  return deliver({ to, subject: `${count} request${count === 1 ? '' : 's'} waiting for your answer`, tag: 'by-hand-reminder',
    text: `${BASE}/home`, html: layout(`${count} request${count === 1 ? '' : 's'} waiting for your answer`, p('Each arrived by email with one-tap links; they are also on Home.') + btn(`${BASE}/home`, 'Open Home')) });
}

// ---- requester emails (1ac) -------------------------------------------------
const closetFooter = centre => `<a href="${BASE}/${centre.slug}">${esc(centre.name)}'s closet</a> · <a href="${BASE}/free-pair-terms">Free pair terms</a> · <a href="${STORE}/pages/size-guide">Size guide</a>`;

async function requestConfirm({ centre, request, items, token }) {
  const url = link(`/${centre.slug}/request/confirm/${token}`);
  return deliver({ to: request.email, subject: `Confirm your request, ${request.name}`, tag: 'request-confirm',
    text: `One tap and your request goes to ${centre.name}: ${url}`,
    html: layout(`Confirm your request, ${esc(request.name)}`, p(`One tap and your request for ${itemsList(items)} goes to ${esc(centre.name)}.`) + btn(url, 'Confirm my request') + p('<span style="color:#666">Link good for 48 hours. Didn\'t ask for this? Ignore it and nothing happens.</span>'), closetFooter(centre)) });
}
async function requestReceived({ centre, request, items, waiting }) {
  const where = request.delivery === 'ship' ? 'shipped to you' : `to pick up at ${esc(centre.name)}`;
  const inner = waiting
    ? p(`You requested ${itemsList(items)}, ${where}.`) + p('This shipment was already funded and is being packed, so yours goes in the next one. We\'ll write again when it\'s on its way. Nothing to do.')
    : p(`You requested ${itemsList(items)}, ${where}.`) + p('Confirmed. It comes with the closet\'s next shipment. We\'ll email you when it\'s ready.');
  return deliver({ to: request.email, subject: waiting ? `You're on the list, ${request.name}` : `Got your request, ${request.name}`, tag: 'request-received',
    text: waiting ? 'You are on the list for the next shipment.' : 'Confirmed. It comes with the closet\'s next shipment.',
    html: layout(waiting ? `You're on the list` : `Got your request, ${esc(request.name)}`, inner + p('<span style="color:#666">Free pairs are final. If your colour is out of stock we send the same style in another colour.</span>'), closetFooter(centre)) });
}
async function requestOnItsWay({ centre, request, items, note }) {
  const pickup = request.delivery !== 'ship';
  return deliver({ to: request.email, subject: pickup ? `On their way to ${centre.name}` : 'On its way to you', tag: 'request-on-way',
    text: pickup ? `Your items are in ${centre.name}'s box, being packed at RUBIES.` : 'Your items are being packed at RUBIES and will come straight to you.',
    html: layout(pickup ? `On their way to ${esc(centre.name)}` : 'On its way to you',
      pickup ? p(`Your ${itemsList(items)} are in ${esc(centre.name)}'s box, which is being packed at RUBIES. We'll email you the moment they're ready to collect. Nothing to do yet.`)
             : p(`Your ${itemsList(items)} ${items.length === 1 ? 'is' : 'are'} being packed at RUBIES and will come straight to you in plain packaging.`) + (note ? p(`<b>From ${esc(centre.name)}:</b> ${esc(note)}`) : '') + p('You\'ll get a shipping confirmation from RUBIES with tracking when it leaves, usually within a few days.'),
      closetFooter(centre)) });
}
async function requestReady({ centre, request, items, note, reminder = false }) {
  return deliver({ to: request.email, subject: `${reminder ? 'Still waiting for you' : 'Ready for you'} at ${centre.name}`, tag: 'request-ready',
    text: `Your ${itemsList(items)} are ready. ${note || ''}`,
    html: layout(`Ready for you at ${esc(centre.name)}`, p(`Your ${itemsList(items)} ${items.length === 1 ? 'is' : 'are'} ready.`) + (note ? p(`<b>From ${esc(centre.name)}:</b> ${esc(note)}`) : ''), closetFooter(centre)) });
}
async function requestDeclined({ centre, request, againFrom, note }) {
  return deliver({ to: request.email, subject: 'About your request', tag: 'request-declined',
    text: `${centre.name} couldn't approve this request. ${againFrom ? `You're welcome to request again from ${againFrom}.` : ''}`,
    html: layout('About your request', p(`Hi ${esc(request.name)}, ${esc(centre.name)} couldn't approve this request.${againFrom ? ` You're welcome to request again from ${esc(againFrom)}, or drop by the centre and talk to someone there.` : ' You\'re welcome to drop by the centre and talk to someone there.'}`) + (note ? p(esc(note)) : ''), closetFooter(centre)) });
}
async function requestEnded({ centre, request }) {
  return deliver({ to: request.email, subject: 'About your request', tag: 'request-ended',
    text: `${centre.name} has left the programme before your request shipped, so it ends with it.`,
    html: layout('About your request', p(`${esc(centre.name)} has left the Virtual Closet programme before your request shipped, so the request ends with it. We're sorry. <a href="${STORE}/pages/donate-your-pre-loved-rubies-clothing">Other centres near you</a>.`)) });
}

// ---- sponsor emails (1ad) ---------------------------------------------------
async function sponsorThanks({ centre, to, amountCents, box, raised, goal, city }) {
  const pairs = Math.max(1, Math.round((amountCents * 2) / 3200));
  return deliver({ to, subject: 'Thank you', tag: 'sponsor-thanks',
    text: `Your ${dollars(amountCents)} went into ${centre.name}'s shipment, and RUBIES matched it.`,
    html: layout('Thank you', p(`Your <b>${dollars(amountCents)}</b> went into ${esc(centre.name)}'s shipment, and RUBIES matched it. That's about ${pairs} pair${pairs === 1 ? '' : 's'} for people${city ? ` in ${esc(city)}` : ''} who requested them.`) + p(`Shipment #${box.number}: ${dollars(raised)} raised of ${dollars(goal)}`) + btn(`${BASE}/${centre.slug}`, `${centre.name}'s closet`)) });
}
async function sponsorArrived({ centre, to, box, items, requests }) {
  return deliver({ to, subject: 'It arrived', tag: 'sponsor-arrived',
    text: `The box you sponsored reached ${centre.name} today: ${items} items, ${requests} of them for people who requested.`,
    html: layout('It arrived', p(`The box you sponsored reached ${esc(centre.name)} today: ${items} items, ${requests} of them for people who requested. Thank you for being part of it.`) + btn(`${BASE}/${centre.slug}?lead=sponsor`, 'Start the next box')) });
}

module.exports = {
  BASE, OPS_BASE, OPERATOR_EMAIL, deliver,
  verifyEmail, resetPassword, invitation, addedToCentre, madeAdmin, emailChanged, confirmEmailChange,
  operatorSignup, operatorNeedsAttention,
  welcome, sponsored, requestNeedsAnswer, requestAutoApproved, boxFunded, boxOnItsWay, boxArrived, statement, byHandReminder,
  requestConfirm, requestReceived, requestOnItsWay, requestReady, requestDeclined, requestEnded,
  sponsorThanks, sponsorArrived,
};
