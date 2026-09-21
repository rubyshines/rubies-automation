'use strict';
/**
 * Every email the Virtual Closet sends, composed here (wireframes 1z, 1aa,
 * 1ab, 1ac, 1ad; copy tightened in the stage 1 review, see
 * .claude/plans/virtual-closet-handover/virtual-closet-stage1-review.md).
 * Sent through SendGrid from care@rubyshines.com. When SendGrid is not
 * configured (local dev) the email is printed to the console with its links,
 * so flows can be walked without a mailbox.
 *
 * Words: a centre reads "box"; a requester or sponsor reads "shipment".
 * Requester subjects never name the items. Matching, never discount or double.
 */
const { sendEmail } = require('../../shared/sendgridClient');
const { esc } = require('../views/layout');
const { dollars } = require('./money');
const { COLOURS, LOGO_PNG, FONT_STACK } = require('./brand');

const BASE = process.env.VC_BASE_URL || `http://localhost:${process.env.PORT || 3850}`;
const OPS_BASE = process.env.VC_OPS_BASE_URL || 'https://ops.rubyshines.com';
const OPERATOR_EMAIL = process.env.VC_OPERATOR_EMAIL || process.env.ALLOWED_EMAIL || 'jamie@rubyshines.com';
const FROM = { fromName: 'RUBIES', fromEmail: 'care@rubyshines.com' };
// Link-mode emails to a centre come from Jamie, so replies and orders land
// with him (Jamie, 2026-09-21). Needs the address to be a verified SendGrid
// sender or under the authenticated domain.
const FROM_JAMIE = { fromName: 'Jamie at RUBIES', fromEmail: OPERATOR_EMAIL };
const STORE = 'https://rubyshines.com';

// ---- the branded shell ------------------------------------------------------
// Tables and inline styles, since that is what email clients honour. The
// store's font falls through the stack (clients do not load web fonts); the
// colours, the square near-black button and the magenta rule are the site's.
const font = `font-family:${FONT_STACK};`;

function layout(title, inner, footerLinks = '', { centre } = {}) {
  // Anchors written plainly in the copy get the site's link colour; buttons
  // and anything already styled are left alone.
  const styled = inner.replace(/<a href="([^"]+)">/g, `<a href="$1" style="color:${COLOURS.blue}">`);
  // Link-mode emails carry "RUBIES × [centre logo]" like the page (Jamie, 2026-09-21).
  const rubies = `<a href="${STORE}" style="text-decoration:none"><img src="${LOGO_PNG}" width="150" alt="RUBIES" style="display:block;border:0;width:150px;height:auto"></a>`;
  const head = centre?.logo_url
    ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td style="vertical-align:middle">${rubies}</td><td style="vertical-align:middle;padding:0 14px;${font}font-size:22px;color:${COLOURS.soft}">×</td><td style="vertical-align:middle">${centre.website ? `<a href="${esc(centre.website)}" style="text-decoration:none">` : ''}<img src="${esc(centre.logo_url)}" alt="${esc(centre.name)}" height="44" style="display:block;border:0;height:44px;width:auto;max-width:160px">${centre.website ? '</a>' : ''}</td></tr></table>`
    : rubies;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title></head>
<body style="margin:0;padding:0;background:${COLOURS.white};${font}color:${COLOURS.ink}">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${COLOURS.white}"><tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px">
<tr><td style="padding:0 0 20px">${head}</td></tr>
<tr><td style="background:${COLOURS.white};border-top:4px solid ${COLOURS.magenta};padding:32px 32px 24px;${font}color:${COLOURS.ink};font-size:16px;line-height:1.6">
<h1 style="margin:0 0 16px;font-size:22px;line-height:1.25;font-weight:600;${font}color:${COLOURS.ink}">${esc(title)}</h1>
${styled}
</td></tr>
<tr><td style="padding:16px 4px 0;font-size:12px;line-height:1.6;color:${COLOURS.soft};${font}">${footerLinks ? footerLinks.replace(/<a href="([^"]+)">/g, `<a href="$1" style="color:${COLOURS.soft}">`) : `RUBIES · <a href="mailto:care@rubyshines.com" style="color:${COLOURS.soft}">care@rubyshines.com</a>`}<br>Never stop shining.</td></tr>
</table></td></tr></table></body></html>`;
}
const p = t => `<p style="margin:0 0 14px;line-height:1.6;color:${COLOURS.ink}">${t}</p>`;
const soft = t => p(`<span style="color:${COLOURS.soft}">${t}</span>`);
const btnStyle = fill => `display:inline-block;padding:13px 26px;border:1px solid ${COLOURS.black};background:${fill ? COLOURS.black : COLOURS.white};color:${fill ? COLOURS.white : COLOURS.black};text-decoration:none;font-weight:500;font-size:15px;line-height:1.2;${font}`;
const btn = (href, label) => `<p style="margin:20px 0"><a href="${href}" style="${btnStyle(true)}">${esc(label)}</a></p>`;
// A pair or trio of actions: the first is the primary, the rest secondary.
const btns = pairs => `<p style="margin:20px 0">${pairs.map(([href, label], i) => `<a href="${href}" style="${btnStyle(i === 0)}margin:0 8px 8px 0">${esc(label)}</a>`).join('')}</p>`;
const itemsList = items => (items || []).map(i => `${esc(i.styleName || i.style)} · ${esc(i.colour)} · ${esc(i.size)}`).join(' and ');
const names = list => (list || []).map(esc).join(' and ');
const plural = (n, one, many) => (n === 1 ? one : many);
const fmtDate = iso => new Date(iso).toLocaleDateString('en-US', { month: 'long', day: 'numeric' });

async function deliver({ to, subject, html, text, tag, from = FROM, attachments }) {
  if (!process.env.SENDGRID_API_KEY || process.env.VC_EMAIL_MODE === 'console') {
    // VC_EMAIL_DUMP_DIR=<dir> also writes each email's HTML there, to look at.
    if (process.env.VC_EMAIL_DUMP_DIR) require('fs').writeFileSync(require('path').join(process.env.VC_EMAIL_DUMP_DIR, `${tag || 'email'}.html`), html);
    const links = [...html.matchAll(/href="([^"]+)"/g)].map(m => m[1]).filter(u => !u.startsWith('mailto:'));
    const att = attachments?.length ? `\n  attachments: ${attachments.map(a => a.filename).join(', ')}` : '';
    console.log(`\n[vc email → ${to}] ${subject} (from ${from.fromEmail})\n  ${(text || '').split('\n').filter(Boolean).slice(0, 3).join('\n  ')}\n  links: ${links.join('\n         ')}${att}\n`);
    return { ok: true, console: true };
  }
  const r = await sendEmail({ to, subject, html, text: text || undefined, ...from, attachments });
  if (!r.ok) console.warn(`[vc email] ${tag || subject} to ${to} failed: ${r.error}`);
  return r;
}

const link = path => `${BASE}${path}`;

// ---- account emails (1ab) ---------------------------------------------------
async function verifyEmail({ user, token, centre }) {
  const url = link(`/verify/${token}`);
  return deliver({ to: user.email, subject: `Confirm your email for ${centre.name}`, tag: 'verify',
    text: `One tap and ${centre.name}'s account is ready: ${url}`,
    html: layout('Confirm your email', p(`One tap and ${esc(centre.name)}'s account is ready.`) + btn(url, 'Confirm my email') + soft("Didn't ask for this? Ignore it and nothing happens.")) });
}
async function resetPassword({ user, token }) {
  const url = link(`/reset/${token}`);
  return deliver({ to: user.email, subject: 'Reset your password', tag: 'reset',
    text: `Choose a new password: ${url}`,
    html: layout('Reset your password', btn(url, 'Choose a new password') + soft("The link works for 24 hours. Didn't ask for this? Ignore it and nothing changes.")) });
}
async function invitation({ email, token, centre, invitedBy, expiresAt }) {
  const url = link(`/invite/${token}`);
  return deliver({ to: email, subject: `${invitedBy} invited you to ${centre.name}'s closet`, tag: 'invite',
    text: `Join the team that runs ${centre.name}'s closet: ${url}`,
    html: layout(`${esc(invitedBy)} invited you to ${esc(centre.name)}'s closet`, p(`Join the team that runs ${esc(centre.name)}'s closet: see requests, send boxes, share the link.`) + btn(url, 'Accept') + soft(`The invitation expires ${fmtDate(expiresAt)}.`)) });
}
async function addedToCentre({ user, centre }) {
  return deliver({ to: user.email, subject: `You're on ${centre.name}'s team`, tag: 'added',
    text: `You've been added as a member. Open your private view: ${link('/home')}`,
    html: layout(`You're on ${esc(centre.name)}'s team`, p("You've been added as a member.") + btn(link('/home'), 'Open your private view')) });
}
async function madeAdmin({ user, centre, by }) {
  return deliver({ to: user.email, subject: `You're now an admin of ${centre.name}`, tag: 'admin',
    text: `${by} handed admin to you. ${link('/home')}`,
    html: layout(`You're now an admin of ${esc(centre.name)}`, p(`${esc(by)} handed admin to you. You can change settings, invite people and leave the programme.`) + btn(link('/home'), 'Open your private view')) });
}
async function emailChanged({ oldEmail, newEmail }) {
  return deliver({ to: oldEmail, subject: 'Your email was changed', tag: 'email-changed',
    text: `Your account now uses ${newEmail}. Wasn't you? Reply to this email.`,
    html: layout('Your email was changed', p(`Your account now uses <b>${esc(newEmail)}</b>. Wasn't you? <a href="mailto:care@rubyshines.com">Tell us</a>.`)) });
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
  return deliver({ to: OPERATOR_EMAIL, subject: `New centre: ${centre.name}${centre.address?.city ? `, ${centre.address.city}` : ''}`, tag: 'op-signup',
    text: `${centre.name} · ${centre.website || ''} · ${prog} · admin ${user.name || ''} ${user.email}. Review: ${q}`,
    html: layout(`New centre: ${esc(centre.name)}`,
      p(`<b>${esc(centre.name)}</b>${centre.address?.city ? `, ${esc(centre.address.city)}` : ''}${centre.website ? ` · <a href="${esc(centre.website)}">${esc(centre.website)}</a>` : ''}`) +
      p(`Ticked: ${esc(prog || 'nothing')}<br>Sizes: ${esc((centre.sizes || []).join(', '))}${centre.kids_sizes ? ', kids' : ''}<br>Admin: ${esc(user.name || '')}${user.role_title ? `, ${esc(user.role_title)}` : ''}, ${esc(user.email)}`) +
      btns([[q, 'Approve'], [q, 'Ask for more'], [q, 'Decline']])) });
}
async function operatorNeedsAttention({ items }) {
  if (!items.length) return { ok: true, skipped: true };
  return deliver({ to: OPERATOR_EMAIL, subject: `Needs attention: ${items.length} thing${items.length === 1 ? '' : 's'}`, tag: 'op-attention',
    text: items.map(i => `- ${i.text}`).join('\n'),
    html: layout(`Needs attention: ${items.length}`, `<ul style="padding-left:18px">${items.map(i => `<li style="margin-bottom:8px">${esc(i.text)} <a href="${OPS_BASE}/closets${i.anchor || ''}">Open</a></li>`).join('')}</ul>`) });
}

// ---- centre programme emails (1aa) -----------------------------------------
function settingsLine(centre) {
  return `sizes ${esc((centre.sizes || []).join(', '))}${centre.kids_sizes ? ', kids' : ''} · ${centre.items_per_request} items per request · ${centre.requests_per_year} requests a person a year · goal ${dollars(centre.goal_cents)} · ${centre.approval_mode === 'by_hand' ? 'approval by hand' : 'automatic approval'} · shipping to a door ${centre.ship_to_door ? 'on' : 'off'}`;
}
const handy = `Worth passing on: <a href="${STORE}/pages/how-it-works">How RUBIES works</a> · <a href="${STORE}/collections/all">Our styles</a> · <a href="${STORE}/pages/size-guide">Size guide</a> · <a href="${BASE}/free-pair-terms">Free pair terms</a>`;

/** The ready-made post a link-mode centre can paste as is. */
function linkPost(centre) {
  return `${centre.name} now has a Virtual Closet with RUBIES, gender-affirming underwear and swimwear for trans girls and women. Shop through our link and get 20% off, and a quarter of your order goes to our closet. Or sponsor the closet directly. ${BASE}/${centre.slug}`;
}

/** The sharing block, the same in the welcome and in every digest (Jamie, 2026-09-21). */
function shareBlock(centre) {
  const url = `${BASE}/${centre.slug}`;
  return p(`<b>Your link</b><br><a href="${url}">${esc(url.replace(/^https?:\/\//, ''))}</a><br>Share it on your socials, your website and your newsletter. Anyone who opens it gets 20% off a RUBIES order, and every order and every sponsor dollar adds to your closet.`) +
    p(`Here's a post you can use as is:<br><span style="color:${COLOURS.soft}">${esc(linkPost(centre))}</span>`);
}

/** The welcome's attachments: the QR on its own, and the printable sign. Each is skipped, never fatal, if it cannot be built. */
async function welcomeAttachments(centre) {
  const url = `${BASE}/${centre.slug}`;
  const out = [];
  try {
    const buf = await require('qrcode').toBuffer(url, { type: 'png', width: 720, margin: 2, color: { dark: '#310C48', light: '#FFFFFF' } });
    out.push({ content: buf.toString('base64'), filename: 'closet-qr.png', type: 'image/png' });
  } catch (err) { console.warn(`[vc email] QR attachment skipped: ${err.message}`); }
  try {
    const pdf = await require('./sign').signPdf(centre, { url, logos: process.env.VC_EMAIL_MODE !== 'console' });
    out.push({ content: pdf.toString('base64'), filename: 'closet-sign.pdf', type: 'application/pdf' });
  } catch (err) { console.warn(`[vc email] sign attachment skipped: ${err.message}`); }
  return out;
}

/** Link mode: from Jamie, congratulations, the link, the QR, the terms in plain words. */
async function welcomeLink({ centre, to }) {
  const url = `${BASE}/${centre.slug}`;
  const attachments = await welcomeAttachments(centre);
  const hasSign = attachments.some(a => a.filename === 'closet-sign.pdf');
  return deliver({ to, subject: 'Your RUBIES Virtual Closet is ready.', tag: 'welcome', from: FROM_JAMIE, attachments,
    text: `Congratulations, ${centre.name}'s Virtual Closet is ready: ${url}. Share it on your socials, your website and your newsletter.${hasSign ? ` Attached is a table sign you can print, fold and stand up, with a QR code that opens your Virtual Closet; reprint it any time at ${url}/qr-sign. The QR code is attached on its own too.` : ''} Your Virtual Closet earns 25% of what shoppers pay through your link, plus every sponsor dollar. When you're ready to order, email me your order and I'll apply what your closet has earned. Partner pricing stays as it is: 50% off any order where the retail value before the discount is $600 or more. Jamie`,
    html: layout('Your RUBIES Virtual Closet is ready.',
      p(`Hi ${esc(centre.name)} team,`) +
      p(`Congratulations, ${esc(centre.name)}'s Virtual Closet is ready.`) +
      shareBlock(centre) +
      p(hasSign
        ? `<b>Attached is a table sign you can print</b>, fold and stand up wherever your community will see it: the front desk, a counter, your table at events. Its QR code opens your Virtual Closet, so anyone can scan it to shop or sponsor, and the back tells whoever is at the table what to say. Print it at 100%, not fit to page, so the folds line up; reprint it any time at <a href="${url}/qr-sign">${esc(url.replace(/^https?:\/\//, ''))}/qr-sign</a>. The QR code is attached on its own too, for your website, socials and newsletter.`
        : `Your QR code is attached${attachments.length ? '' : ` (or fetch it any time at <a href="${url}/qr.png">${esc(url.replace(/^https?:\/\//, ''))}/qr.png</a>)`}.`) +
      p(`<b>How it adds up.</b> Your Virtual Closet earns 25% of what shoppers pay through your link, plus every sponsor dollar.`) +
      p(`<b>When you're ready to order,</b> email me your order and I'll apply what your closet has earned. Partner pricing stays as it is: 50% off any order where the retail value before the discount is $600 or more.`) +
      p(`Questions any time.<br>Jamie<br><a href="mailto:${OPERATOR_EMAIL}">${OPERATOR_EMAIL}</a>`),
      `RUBIES · <a href="mailto:${OPERATOR_EMAIL}">${OPERATOR_EMAIL}</a>`, { centre }) });
}

/** Link mode: at most one a day, only on a day with activity. From care@, so a reply lands in CS; the welcome is the one from Jamie (Jamie, 2026-09-21). */
async function activity({ centre, to, orders = 0, orderCents = 0, sponsors = 0, sponsorCents = 0, balanceCents = 0, raisedCents = 0 }) {
  const goalCents = centre.goal_cents || require('./money').LINK_DEFAULT_GOAL_CENTS;
  const lines = [];
  if (orders) lines.push(`${orders} order${plural(orders, '', 's')} through your link put <b>${dollars(orderCents)}</b> in.`);
  if (sponsors) lines.push(`${sponsors} sponsor${plural(sponsors, '', 's')} put <b>${dollars(sponsorCents)}</b> in.`);
  const textLines = lines.map(l => l.replace(/<[^>]+>/g, ''));
  // The subject leads with the money that came in (Jamie, 2026-09-21): "$49.60 added to [Centre]'s Virtual Closet today".
  const subject = `${dollars(orderCents + sponsorCents)} added to ${centre.name}'s Virtual Closet today`;
  return deliver({ to, subject, tag: 'activity',
    text: `${textLines.join(' ')} Your balance is ${dollars(balanceCents)}. Raised so far: ${dollars(raisedCents)} of your ${dollars(goalCents)} goal. Keep sharing your link: ${BASE}/${centre.slug}. To order, email Jamie at ${OPERATOR_EMAIL}.`,
    html: layout(esc(subject),
      lines.map(p).join('') +
      p(`Your balance is <b>${dollars(balanceCents)}</b>. Raised so far: ${dollars(raisedCents)} of your ${dollars(goalCents)} goal.`) +
      p(`<b>Keep it going.</b>`) + shareBlock(centre) +
      p(`To order, email Jamie at <a href="mailto:${OPERATOR_EMAIL}">${OPERATOR_EMAIL}</a>.`), '', { centre }) });
}

async function welcome({ centre, to }) {
  if (centre.mode === 'link') return welcomeLink({ centre, to });
  const url = `${BASE}/${centre.slug}`;
  const byHand = centre.approval_mode === 'by_hand';
  return deliver({ to, subject: `Your closet is open, ${centre.name}`, tag: 'welcome',
    text: `${centre.name}'s closet is live: ${url}. Private view: ${BASE}/home`,
    html: layout(`Your closet is open, ${esc(centre.name)}`,
      p(`Hi ${esc(centre.name)} team,`) +
      p(`${esc(centre.name)}'s closet is live. Keep this email; it has everything the next person running the closet will need.`) +
      p(`<b>Your link</b><br><a href="${url}">${esc(url.replace(/^https?:\/\//, ''))}</a><br>Everyone who opens it gets 20% off one order, and every two items bought put one in your closet. Share it on your site, your socials, your noticeboard. A ready-made post and a QR code are waiting in your <a href="${BASE}/home">private view</a>.`) +
      p(`<b>How it works.</b> Shopping, requesting and sponsoring all go into one box, and RUBIES matches every dollar in it. Requests are ${byHand ? 'sent to you by email to approve or decline with one tap' : 'approved automatically within the limits you set'}. When the box reaches your goal, we email you to send it. It arrives at your address with everyone's requested items inside.`) +
      p(`<b>Your settings:</b> ${settingsLine(centre)}. <a href="${BASE}/settings">Change any of these</a>.`) +
      (centre.programmes?.pass_it_on ? p(`You're on the donation map too, with your pin linked to your closet.`) : '') +
      p(handy) + btn(`${BASE}/home`, 'Open your private view') +
      p(`Questions, any time: Jamie, <a href="mailto:jamie@rubyshines.com">jamie@rubyshines.com</a>.`)) });
}
async function sponsored({ centre, to, amountCents, box, raised, goal }) {
  return deliver({ to, subject: `Someone sponsored ${centre.name}'s closet`, tag: 'sponsored',
    text: `A sponsor just put ${dollars(amountCents)} into box #${box.number}. Box #${box.number}: ${dollars(raised)} raised of ${dollars(goal)}.`,
    html: layout(`Someone sponsored ${esc(centre.name)}'s closet`, p(`A sponsor just put <b>${dollars(amountCents)}</b> into box #${box.number}. RUBIES matches it when the box ships.`) + p(`Box #${box.number}: ${dollars(raised)} raised of ${dollars(goal)}`) + btn(`${BASE}/home`, 'See the box')) });
}
async function requestNeedsAnswer({ centre, to, request, items, approveToken, declineToken }) {
  const a = link(`/answer/${approveToken}`), d = link(`/answer/${declineToken}`);
  const how = request.delivery === 'ship' ? 'to be shipped to their door ($15 from the box)' : 'to pick up at the centre';
  return deliver({ to, subject: 'A request for your closet', tag: 'needs-answer',
    text: `${request.name} asked for ${itemsList(items)}, ${how}. Approve: ${a} Decline: ${d}`,
    html: layout('A request for your closet', p(`<b>${esc(request.name)}</b> asked for ${itemsList(items)}, ${how}.`) + (request.words ? p(`“${esc(request.words)}”`) : '') + btns([[a, 'Approve'], [d, 'Decline']]) + soft('One tap, no sign-in. These links work for 14 days; after that, answer from your private view.')) });
}
async function requestAutoApproved({ centre, to, request, items, box, count }) {
  return deliver({ to, subject: `A request joined box #${box.number}`, tag: 'auto-approved',
    text: `${request.name} asked for ${items.length} item(s) and was approved within your limits. Box #${box.number} now has ${count} requests.`,
    html: layout(`A request joined box #${box.number}`, p(`${esc(request.name)} asked for ${items.length} item${plural(items.length, '', 's')} and was approved within your limits. Box #${box.number} now has ${count} request${plural(count, '', 's')}.`) + btn(`${BASE}/home`, 'See them')) });
}
async function boxFunded({ centre, to, box, raised }) {
  return deliver({ to, subject: `Box #${box.number} is funded`, tag: 'funded',
    text: `You've reached ${dollars(raised)}. Fill and send: ${BASE}/send`,
    html: layout(`Box #${box.number} is funded`, p(`You've reached <b>${dollars(raised)}</b>. RUBIES matches it when the box ships.`) + p(`Everyone's requested items are already in. Choose the rest yourself, or let us fill it across your sizes.`) + btns([[`${BASE}/send`, 'Fill and send the box'], [`${BASE}/home`, 'Keep it growing']]) + soft('Requests that come in before you send it go in too; the goal grows to cover them.')) });
}
async function boxOnItsWay({ centre, to, box, items, pickups = [], doors = [], nextBox }) {
  const inside = pickups.length ? `Inside: requests from ${names(pickups)}, plus the rest across your sizes.` : 'Inside: the rest across your sizes.';
  const straight = doors.length ? ` ${names(doors)}'s items are going straight to their door.` : '';
  return deliver({ to, subject: `Box #${box.number} is on its way`, tag: 'box-shipped',
    text: `${items} items are heading to your address. ${box.carrier || ''} ${box.tracking_number || ''}`,
    html: layout(`Box #${box.number} is on its way`, p(`${items} items are heading to your address.${box.carrier || box.tracking_number ? ` ${esc(box.carrier || '')} ${esc(box.tracking_number || '')}` : ''}`) + p(`${inside}${straight}`) + btn(`${BASE}/history`, 'Packing list') + (nextBox ? p(`Box #${nextBox.number} is open.`) : '')) });
}
async function boxArrived({ centre, to, box, pickups }) {
  return deliver({ to, subject: `Box #${box.number} arrived`, tag: 'box-arrived',
    text: `Box #${box.number} arrived; ${pickups} people were told it's ready to collect.`,
    html: layout(`Box #${box.number} arrived`, p(`${pickups} ${plural(pickups, 'person was', 'people were')} told it's ready to collect. Nothing to do.`) + btn(`${BASE}/home`, 'Open your private view')) });
}
async function statement({ centre, to, month, stats }) {
  const rows = Object.entries(stats).map(([k, v]) => `<tr><td style="padding:6px 12px 6px 0;color:${COLOURS.soft};border-bottom:1px solid ${COLOURS.grey}">${esc(k)}</td><td style="padding:6px 0;font-weight:600;border-bottom:1px solid ${COLOURS.grey}">${esc(String(v))}</td></tr>`).join('');
  return deliver({ to, subject: `${centre.name}'s closet in ${month}`, tag: 'statement',
    text: Object.entries(stats).map(([k, v]) => `${k}: ${v}`).join('\n'),
    html: layout(`${esc(centre.name)}'s closet in ${esc(month)}`, `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:100%;font-size:15px">${rows}</table>` + btn(`${BASE}/history`, 'Open your private view')) });
}
async function byHandReminder({ centre, to, count }) {
  return deliver({ to, subject: `${count} request${plural(count, '', 's')} waiting for your answer`, tag: 'by-hand-reminder',
    text: `${BASE}/home`, html: layout(`${count} request${plural(count, '', 's')} waiting for your answer`, p('Each arrived by email with one-tap links; they are also on Home.') + btn(`${BASE}/home`, 'Open Home')) });
}

// ---- requester emails (1ac) -------------------------------------------------
const closetFooter = centre => `<a href="${BASE}/${centre.slug}">${esc(centre.name)}'s closet</a> · <a href="${BASE}/free-pair-terms">Free pair terms</a> · <a href="${STORE}/pages/size-guide">Size guide</a>`;
const finalLine = soft('Free pairs are final. If your colour runs out, we send the same style in another colour.');

async function requestConfirm({ centre, request, items, token }) {
  const url = link(`/${centre.slug}/request/confirm/${token}`);
  return deliver({ to: request.email, subject: 'One tap to send your request', tag: 'request-confirm',
    text: `Tap and your request goes to ${centre.name}: ${url}`,
    html: layout('One tap to send your request', p(`Hi ${esc(request.name)}, tap below and your request for ${itemsList(items)} goes to ${esc(centre.name)}.`) + btn(url, 'Confirm my request') + soft("The link works for 48 hours. Didn't ask for this? Ignore it and nothing happens."), closetFooter(centre)) });
}
/**
 * After a request is placed. `needsAnswer`: the centre approves by hand and
 * has not answered yet. `approved`: a by-hand centre just said yes. `waiting`:
 * legacy rows placed on a wait list. Otherwise: approved automatically.
 */
async function requestReceived({ centre, request, items, waiting = false, needsAnswer = false, approved = false }) {
  const where = request.delivery === 'ship' ? 'shipped to you' : `to pick up at ${esc(centre.name)}`;
  let subject, title, inner;
  if (waiting) {
    subject = `You're on the list, ${request.name}`; title = "You're on the list";
    inner = p(`You asked for ${itemsList(items)}, ${where}.`) + p("This shipment is already on its way to being packed, so yours goes in the next one. We'll write again when it's on its way. Nothing to do for now.");
  } else if (needsAnswer) {
    subject = `Got your request, ${request.name}`; title = `Got your request, ${esc(request.name)}`;
    inner = p(`You asked for ${itemsList(items)}, ${where}.`) + p(`${esc(centre.name)} looks over each request. You'll hear from us at this address once they've answered.`);
  } else if (approved) {
    subject = `You're in, ${request.name}`; title = `You're in, ${esc(request.name)}`;
    inner = p(`${esc(centre.name)} approved your request for ${itemsList(items)}, ${where}.`) + p("It comes with the closet's next shipment, and we'll email you when it's ready.");
  } else {
    subject = `Got your request, ${request.name}`; title = `Got your request, ${esc(request.name)}`;
    inner = p(`You asked for ${itemsList(items)}, ${where}. It's in.`) + p("It comes with the closet's next shipment, and we'll email you when it's ready.");
  }
  return deliver({ to: request.email, subject, tag: 'request-received',
    text: waiting ? 'You are on the list for the next shipment.' : needsAnswer ? `${centre.name} looks over each request; you will hear from us once they have answered.` : "It comes with the closet's next shipment.",
    html: layout(title, inner + finalLine, closetFooter(centre)) });
}
async function requestOnItsWay({ centre, request, items, note }) {
  const pickup = request.delivery !== 'ship';
  return deliver({ to: request.email, subject: pickup ? `On their way to ${centre.name}` : 'On its way to you', tag: 'request-on-way',
    text: pickup ? `Your items are in ${centre.name}'s shipment, being packed at RUBIES now.` : 'Your items are being packed at RUBIES and will come straight to you.',
    html: layout(pickup ? `On their way to ${esc(centre.name)}` : 'On its way to you',
      pickup ? p(`Your items are in ${esc(centre.name)}'s shipment, being packed at RUBIES now. We'll email you the moment they're ready to collect.`)
             : p(`Your ${itemsList(items)} ${plural(items.length, 'is', 'are')} being packed at RUBIES and will come straight to you in plain packaging.`) + (note ? p(`<b>From ${esc(centre.name)}:</b> ${esc(note)}`) : '') + p('A shipping confirmation with tracking follows when it leaves, usually within a few days.'),
      closetFooter(centre)) });
}
async function requestReady({ centre, request, items, note, reminder = false }) {
  const title = reminder ? `Still waiting for you at ${centre.name}` : `Ready for you at ${centre.name}`;
  return deliver({ to: request.email, subject: title, tag: 'request-ready',
    text: `Your ${itemsList(items)} ${reminder ? 'are still at the closet' : 'are ready'}. ${note || ''}`,
    html: layout(title, p(reminder ? `Your ${itemsList(items)} ${plural(items.length, 'is', 'are')} still at the closet, whenever you're ready.` : `Your ${itemsList(items)} ${plural(items.length, 'is', 'are')} ready.`) + (note ? p(`<b>From ${esc(centre.name)}:</b> ${esc(note)}`) : ''), closetFooter(centre)) });
}
async function requestDeclined({ centre, request, againFrom, note }) {
  return deliver({ to: request.email, subject: 'About your request', tag: 'request-declined',
    text: `${centre.name} wasn't able to approve this request. ${againFrom ? `You can request again from ${againFrom}.` : ''}`,
    html: layout('About your request', p(`Hi ${esc(request.name)}, ${esc(centre.name)} wasn't able to approve this request. If you'd like to talk it through, drop by the centre and ask for someone who runs the closet.`) + (note ? p(esc(note)) : '') + (againFrom ? p(`You can request again from ${esc(againFrom)}.`) : ''), closetFooter(centre)) });
}
async function requestEnded({ centre, request }) {
  return deliver({ to: request.email, subject: 'About your request', tag: 'request-ended',
    text: `${centre.name} has left the closet programme, so your request has ended with them.`,
    html: layout('About your request', p(`Hi ${esc(request.name)}, ${esc(centre.name)} has left the closet programme, so your request has ended with them. We're sorry. <a href="${STORE}/pages/donate-your-pre-loved-rubies-clothing">Other centres near you</a> are on the map, and you can request there.`)) });
}

// ---- sponsor emails (1ad) ---------------------------------------------------
async function sponsorThanks({ centre, to, amountCents, box, raised, goal, city }) {
  if (centre.mode === 'link') {
    // Link mode: "Your $25 went to [Centre]'s Virtual Closet. Thanks for your support." (Jamie, 2026-09-21)
    const total = raised ? p(`<b>${dollars(raised)}</b> raised so far. RUBIES matches it: ${dollars(raised * 2)} of underwear and swimwear for the closet.`) : '';
    return deliver({ to, subject: `Thank you from ${centre.name}'s Virtual Closet`, tag: 'sponsor-thanks',
      text: `Your ${dollars(amountCents)} went to ${centre.name}'s Virtual Closet. Thanks for your support.`,
      html: layout(`Thank you from ${esc(centre.name)}'s Virtual Closet`, p(`Your <b>${dollars(amountCents)}</b> went to ${esc(centre.name)}'s Virtual Closet. Thanks for your support.`) + total + btn(`${BASE}/${centre.slug}`, `${centre.name}'s Virtual Closet`), '', { centre }) });
  }
  const pairs = Math.max(1, Math.round((amountCents * 2) / 3200));
  return deliver({ to, subject: `Thank you from ${centre.name}'s closet`, tag: 'sponsor-thanks',
    text: `Your ${dollars(amountCents)} went into ${centre.name}'s shipment, and RUBIES matched it.`,
    html: layout(`Thank you from ${esc(centre.name)}'s closet`, p(`Your <b>${dollars(amountCents)}</b> went into ${esc(centre.name)}'s shipment, and RUBIES matched it. That's about ${pairs} pair${plural(pairs, '', 's')} for people${city ? ` in ${esc(city)}` : ''} who need them.`) + p(`Shipment #${box.number}: ${dollars(raised)} raised of ${dollars(goal)}`) + btn(`${BASE}/${centre.slug}`, `${centre.name}'s closet`)) });
}
async function sponsorArrived({ centre, to, box, items, requests }) {
  return deliver({ to, subject: 'It arrived', tag: 'sponsor-arrived',
    text: `The shipment you sponsored reached ${centre.name} today: ${items} items, ${requests} of them for people who requested.`,
    html: layout('It arrived', p(`The shipment you sponsored reached ${esc(centre.name)} today: ${items} items, ${requests} of them for people who requested. Thank you for being part of it.`) + btn(`${BASE}/${centre.slug}?lead=sponsor`, 'Start the next shipment')) });
}

module.exports = {
  BASE, OPS_BASE, OPERATOR_EMAIL, deliver, layout, btn, btns,
  verifyEmail, resetPassword, invitation, addedToCentre, madeAdmin, emailChanged, confirmEmailChange,
  operatorSignup, operatorNeedsAttention,
  welcome, welcomeLink, activity, linkPost, sponsored, requestNeedsAnswer, requestAutoApproved, boxFunded, boxOnItsWay, boxArrived, statement, byHandReminder,
  requestConfirm, requestReceived, requestOnItsWay, requestReady, requestDeclined, requestEnded,
  sponsorThanks, sponsorArrived,
};
