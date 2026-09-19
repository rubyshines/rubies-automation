'use strict';
/** The centre's private view: Home (1v, 2d), Settings (1w, 1t, 1s), Send the box (1x), History (1y). */
const { page, esc, LINKS, addressLine } = require('./layout');
const { SIZES, MENU } = require('../lib/catalog');
const { dollars } = require('../lib/money');
const { sizeChips, errorBox } = require('./programme');
const requestsLib = require('../lib/requests');
const { fmtDate } = require('./closet');

const BASE = () => process.env.VC_BASE_URL || `http://localhost:${process.env.PORT || 3850}`;

function banners({ centre, actingAs, flash }) {
  let out = '';
  if (actingAs) out += `<div class="banner op">Operator view: you are seeing ${esc(centre.name)}'s Home as they see it. Every action is logged and emailed to their admins. <a href="/ops/stop">Stop</a></div>`;
  if (centre.status === 'pending') out += `<div class="banner warn">Waiting for approval. A person at RUBIES reviews every new centre, usually within a few days. Your page goes live the moment we do.</div>`;
  if (centre.status === 'paused') out += `<div class="banner warn">Your page is paused by RUBIES${centre.paused_reason ? `: ${esc(centre.paused_reason)}` : ''}. Write to jamie@rubyshines.com.</div>`;
  if (flash) out += `<div class="banner">${esc(flash)}</div>`;
  return out;
}

function itemsHtml(items) {
  return requestsLib.describeItems(items).map(i => `${esc(i.styleName)} · ${esc(i.colour)} · ${esc(i.size)}`).join('<br>');
}

function wordsCell(r, role) {
  if (!r.words) return '<span class="soft">none</span>';
  const q = `“${esc(r.words.length > 90 ? r.words.slice(0, 90) + '…' : r.words)}”`;
  if (!r.words_shareable) return `${q}<br><span class="fine">private</span>`;
  if (r.words_published_at) return `${q}<br><span class="pill ok">Published</span> ${role === 'admin' ? `<form class="inline" method="post" action="/requests/${r.id}/unpublish"><button class="btn btn-small btn-quiet">Unpublish</button></form>` : ''}`;
  return `${q}<br><span class="fine">Shareable, not published.</span> ${role === 'admin' ? `<form class="inline" method="post" action="/requests/${r.id}/publish"><button class="btn btn-small btn-line" title="Check for anything that points at a real person or place before publishing">Publish</button></form>` : ''}`;
}

function requestsTable({ centre, requests, role, byHand, filter = 'all' }) {
  const shown = filter === 'all' ? requests : requests.filter(r => filter === 'needs' ? r.status === 'needs_answer' : filter === 'approved' ? ['approved', 'in_box', 'waiting'].includes(r.status) : r.status === 'declined');
  const rows = shown.map(r => {
    const answer = byHand && r.status === 'needs_answer'
      ? `<div class="doors"><form method="post" action="/requests/${r.id}/approve"><button class="btn btn-small btn-fill">Approve</button></form><a class="btn btn-small btn-line" href="/requests/${r.id}/decline">Decline</a></div>`
      : `<span class="pill ${r.status === 'declined' ? 'bad' : r.status === 'waiting' ? 'warn' : 'ok'}">${esc(requestsLib.statusLabel(r))}</span>${r.decided_by && r.decided_by.startsWith('user:') ? `<br><span class="fine">by ${esc(r.decided_by_name || 'the team')}</span>` : ''}`;
    return `<tr><td>${esc(r.name)}</td><td>${itemsHtml(r.items)}</td><td>${r.delivery === 'ship' ? 'Ship <span class="fine">($15 from the box)</span>' : 'Pickup'}</td><td>${wordsCell(r, role)}</td><td class="soft">${ago(r.created_at)}</td><td>${answer}</td></tr>`;
  }).join('');
  const chips = byHand ? `<div class="chips" style="margin-bottom:8px"><a class="chip ${filter === 'needs' ? 'on' : ''}" href="/home?filter=needs">Needs your answer · ${requests.filter(r => r.status === 'needs_answer').length}</a><a class="chip ${filter === 'approved' ? 'on' : ''}" href="/home?filter=approved">Approved · ${requests.filter(r => ['approved', 'in_box', 'waiting'].includes(r.status)).length}</a><a class="chip ${filter === 'declined' ? 'on' : ''}" href="/home?filter=declined">Declined</a><a class="chip ${filter === 'all' ? 'on' : ''}" href="/home">All</a></div>` : '';
  return `${chips}<div class="tbl"><table><thead><tr><th>Name they go by</th><th>Items</th><th>Pickup or ship</th><th>Their words</th><th>Requested</th><th>${byHand ? 'Answer' : 'Status'}</th></tr></thead><tbody>${rows || '<tr><td colspan="6" class="soft">No requests yet.</td></tr>'}</tbody></table></div>`;
}

function home({ centre, user, role, actingAs, sum, lastSent, requests, month, share, passItOn, flash, filter, notCollected }) {
  const byHand = centre.approval_mode === 'by_hand';
  const needs = requests.filter(r => r.status === 'needs_answer').length;
  const boxRequests = requests.filter(r => r.box_id === sum.box?.id || r.status === 'waiting');
  const funded = sum.funded;
  const body = `
${byHand && needs ? `<div class="banner warn" style="margin:12px 0"><b>${needs} request${needs === 1 ? '' : 's'} need your answer.</b> Approve or decline below; each also arrived by email with one-tap links.</div>` : ''}
<section class="two">
  <div class="card">
    <div class="progress-head"><h3>Box #${sum.number}</h3><span class="soft">${sum.state === 'sent' || sum.state === 'shipped' ? 'Being packed at RUBIES' : `Open · requests ${centre.requests_paused_at ? 'paused' : 'on'}`}</span></div>
    <div class="amount">${dollars(sum.raised)} <small>raised of ${dollars(sum.goal)}</small></div>
    <div class="bar"><span style="width:${sum.goal ? Math.min(100, Math.round(sum.raised / sum.goal * 100)) : 0}%"></span></div>
    <p class="fine">RUBIES matches every dollar when it ships${sum.state === 'grown' ? '. The goal grew to cover everyone approved' : ''}.</p>
    <table><tr><td class="soft">From community orders</td><td><b>${dollars(sum.sources.orders)}</b></td></tr><tr><td class="soft">From sponsors (${sum.sources.sponsorCount})</td><td><b>${dollars(sum.sources.sponsors)}</b></td></tr><tr><td class="soft">From ${esc(centre.name)}</td><td><b>${dollars(sum.sources.centre)}</b></td></tr><tr><td class="soft">Carried over from box #${sum.number - 1}</td><td><b>${dollars(sum.sources.carry)}</b></td></tr></table>
    ${funded ? `<a class="btn btn-fill" href="/send">Send the box</a><p class="fine">Funded. Send it now, or keep it growing; requests that arrive before you send go in too, and the goal grows to cover them.</p>` : `<span class="btn btn-fill disabled">Send the box</span><p class="fine">Available at ${dollars(sum.goal)}. Or keep it growing past the goal; you choose then.</p>`}
  </div>
  <div>
    ${lastSent && lastSent.status !== 'delivered' ? `<div class="card" style="margin-bottom:16px"><h3>Box #${lastSent.number} · ${lastSent.status === 'shipped' ? 'on its way' : 'being packed at RUBIES'}</h3><p>${lastSent.carrier ? `${esc(lastSent.carrier)} ${esc(lastSent.tracking_number || '')}. ` : ''}${lastSent.items_count || ''} items. People who requested pickup will be emailed instructions the day it's delivered.</p></div>` : ''}
    <div class="card" style="margin-bottom:16px"><h3>Add to the box</h3><p>From your own budget, paid now by card. Matched like every other dollar.</p><form class="doors" method="post" action="/add-to-box"><label class="field" style="width:120px">$<input class="plain" type="number" name="dollars" min="1" step="1" value="50"></label><button class="btn btn-line" type="submit">Pay and add</button></form></div>
    <div class="card"><h3>This month</h3><div class="kpis"><div class="kpi"><b>${month.visits}</b><span>Link visits</span></div><div class="kpi"><b>${month.orders}</b><span>Orders</span></div><div class="kpi"><b>${month.sponsors}</b><span>Sponsors</span></div><div class="kpi"><b>${month.requests}</b><span>Requests</span></div></div></div>
  </div>
</section>
${notCollected?.length ? `<section><h3>Not collected yet?</h3><p class="soft">Box #${lastSent.number} arrived ${fmtDate(lastSent.delivered_at)}. Still waiting: ${notCollected.map(r => `${esc(r.name)} <form class="inline" method="post" action="/requests/${r.id}/remind"><button class="btn btn-small btn-quiet">Send a reminder</button></form>`).join(', ')}.</p></section>` : ''}
<section>
  <div class="progress-head"><h2>Requests in this box · ${boxRequests.filter(r => r.status !== 'declined').length}</h2>
    <form method="post" action="/home/pause">${centre.requests_paused_at ? `<span class="pill warn">Requests paused since ${fmtDate(centre.requests_paused_at)}</span> <button class="btn btn-small btn-line" name="action" value="resume">Resume requests</button>` : `<button class="btn btn-small btn-quiet" name="action" value="pause">Pause requests</button>`}</form></div>
  ${centre.requests_paused_at ? '<p class="fine">Your page says requests are paused. Existing requests aren\'t affected.</p>' : ''}
  ${requestsTable({ centre, requests: byHand ? requests : boxRequests, role, byHand, filter })}
  <p class="fine">${byHand ? 'Unanswered after 7 days: a reminder. Requests don\'t grow the goal until approved.' : 'Automatic approval within your limits, as set in Settings.'} No addresses ever appear here. Requests appear only once the requester has confirmed their email.</p>
</section>
<section class="two">
  <div>
    <h2>Share your closet</h2>
    <div class="share">
      ${share.links.map(l => `<div class="share-row"><div><code>${esc(l.url)}</code><br><span class="fine">${esc(l.note)}</span></div><button class="btn btn-small btn-quiet" type="button" data-copy="${esc(l.url)}">Copy</button></div>`).join('')}
    </div>
    <p class="fine">Same page, different thing on top. The plain link shows all three equally.</p>
    <div class="doors"><a class="btn btn-small btn-line" href="/share/qr.svg" download="closet-qr.svg">Download QR</a><button class="btn btn-small btn-line" type="button" data-copy="${esc(share.post)}">Copy a ready-made post</button><a class="btn btn-small btn-quiet" href="/${centre.slug}" target="_blank" rel="noopener">Preview your page</a></div>
    <p class="fine">Everyone who arrives from this link gets 20% off one order, new or returning, and every two items they buy put one in your closet.</p>
  </div>
  <div>
    ${centre.programmes?.pass_it_on ? `<h2>Pass It On</h2><p>${centre.map_listed ? 'Listed on the donation map' : 'Not listed on the map'}${centre.map_pin_to_closet ? ', pin linked to your closet' : ''}. ${passItOn.routed} customer${passItOn.routed === 1 ? ' was' : 's were'} given your address this month; ${passItOn.mapVisits} visited your closet from the map.</p><a href="/settings#pass-it-on">Manage in Settings</a>` : ''}
  </div>
</section>`;
  return page({ title: `${centre.name} · Home`, mode: 'centre', centre, user, body, banner: banners({ centre, actingAs, flash }) });
}

function declineForm({ centre, request, errors = [] }) {
  const body = `<section class="card narrow"><h1>Decline: ${esc(request.name)}</h1><p>${esc(request.name)} gets a short, kind email: ${esc(centre.name)} wasn't able to approve this request, and they're welcome to drop by the centre. Nothing else is said unless you add a line below.</p>${errorBox(errors)}
<form class="form" method="post" action="/requests/${request.id}/decline"><label class="check"><input type="checkbox" name="counts" value="1"> Also count this toward their ${centre.requests_per_year} a year <span class="fine">(off by default: a declined request doesn't use up a turn)</span></label><label>A line for them, optional <input type="text" name="note" maxlength="200"></label><div class="doors"><button class="btn btn-fill">Decline and send</button><a class="btn btn-quiet" href="/home">Cancel</a></div></form></section>`;
  return page({ title: 'Decline', mode: 'centre', centre, body });
}

function settings({ centre, user, role, team, errors = [], saved = '', actingAs, invitesSent }) {
  const admin = role === 'admin';
  const dis = admin ? '' : 'disabled';
  const body = `
<div class="side">
<nav><a href="#closet" class="active">Closet</a><a href="#pass-it-on">Pass It On</a><a href="#centre">Centre</a><a href="#team">Team</a><a href="#account">Account</a><a href="#leave">Leave the programme</a></nav>
<div>
${saved ? `<div class="ok">${esc(saved)}</div>` : ''}${errorBox(errors)}
${!admin ? '<p class="fine">Members can see settings; admins change them.</p>' : ''}
<form class="settings-block" id="closet" method="post" action="/settings/closet">
  <h2>Closet</h2>
  <fieldset><legend>Sizes your closet takes and offers</legend>${sizeChips(centre.sizes, { kids: centre.kids_sizes })}<p class="fine">Used by both programmes.</p></fieldset>
  <div class="row">
    <label>Items per request <select name="items_per_request" ${dis}>${[1, 2, 3, 4].map(n => `<option ${centre.items_per_request === n ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
    <label>How often one person may request <select name="requests_per_year" ${dis}>${[1, 2, 3, 4, 6, 12].map(n => `<option value="${n}" ${centre.requests_per_year === n ? 'selected' : ''}>${n} time${n === 1 ? '' : 's'} a year</option>`).join('')}</select></label>
    <label>Funding goal for each box <input type="number" name="goal" min="300" step="10" value="${Math.round(centre.goal_cents / 100)}" ${dis}></label>
  </div>
  <p class="fine">$300 minimum; set it higher if you like. It grows on its own to cover everyone approved.</p>
  <fieldset><legend>Approving requests</legend><label class="radio"><input type="radio" name="approval_mode" value="automatic" ${centre.approval_mode === 'automatic' ? 'checked' : ''} ${dis}> Automatic, within the limits above <span class="fine">(recommended)</span></label><label class="radio"><input type="radio" name="approval_mode" value="by_hand" ${centre.approval_mode === 'by_hand' ? 'checked' : ''} ${dis}> By hand: we email you each request with approve and decline links</label></fieldset>
  <fieldset><legend>Shipping to a door</legend><label class="radio"><input type="radio" name="ship_to_door" value="1" ${centre.ship_to_door ? 'checked' : ''} ${dis}> Allowed. Costs the box $15 per package.</label><label class="radio"><input type="radio" name="ship_to_door" value="0" ${!centre.ship_to_door ? 'checked' : ''} ${dis}> Pickup at the centre only</label></fieldset>
  <label class="check"><input type="checkbox" name="paused" value="1" ${centre.requests_paused_at ? 'checked' : ''} ${dis}> Pause new requests for now</label>
  <p class="fine">Words from the community on your page: nothing shows unless an admin publishes it from Home. Admins can unpublish any time.</p>
  ${admin ? '<button class="btn btn-fill">Save</button>' : ''}
</form>
<form class="settings-block" id="pass-it-on" method="post" action="/settings/pass-it-on">
  <h2>Pass It On</h2>
  ${centre.programmes?.pass_it_on ? `
  <label class="check"><input type="checkbox" name="map_listed" value="1" ${centre.map_listed ? 'checked' : ''} ${dis}> Show ${esc(centre.name)} on the public donation map</label>
  <label class="check"><input type="checkbox" name="map_pin_to_closet" value="1" ${centre.map_pin_to_closet ? 'checked' : ''} ${dis}> Link the map pin to our closet page (${esc(BASE().replace(/^https?:\/\//, ''))}/${esc(centre.slug)})</label>
  <label class="check"><input type="checkbox" name="pass_it_on_paused" value="1" ${centre.pass_it_on_paused_at ? 'checked' : ''} ${dis}> Pause: stop routing items to us for now</label>
  <p class="fine">Items are sent to the address below. Uses the same sizes as the closet.</p>` : `<label class="check"><input type="checkbox" name="join" value="1" ${dis}> Join Pass It On: customers' exchanged and returned RUBIES items are routed to your closet, and you appear on the donation map.</label>`}
  ${admin ? '<button class="btn btn-fill">Save</button>' : ''}
</form>
<form class="settings-block" id="centre" method="post" action="/settings/centre">
  <h2>Centre</h2>
  <label>Centre name <input type="text" name="name" value="${esc(centre.name)}" ${dis} required></label>
  <label>Website <input type="url" name="website" value="${esc(centre.website || '')}" ${dis}></label>
  <label>Logo, for your closet page <input type="url" name="logo_url" value="${esc(centre.logo_url || '')}" placeholder="https://" ${dis}></label>
  <fieldset><legend>Address boxes and items ship to</legend>
    <label>Street <input type="text" name="street" value="${esc(centre.address?.street || '')}" ${dis}></label>
    <div class="row"><label>City <input type="text" name="city" value="${esc(centre.address?.city || '')}" ${dis}></label><label>State / province <input type="text" name="region" value="${esc(centre.address?.region || '')}" ${dis}></label><label>Postal code <input type="text" name="postal" value="${esc(centre.address?.postal || '')}" ${dis}></label></div>
    <div class="row"><label>Country <input type="text" name="country" value="${esc(centre.address?.country || 'US')}" ${dis}></label><label>Front desk hours <input type="text" name="hours" value="${esc(centre.address?.hours || '')}" placeholder="Mon to Fri, 10 to 6" ${dis}></label><label>Phone <input type="text" name="phone" value="${esc(centre.address?.phone || '')}" ${dis}></label></div>
  </fieldset>
  <label>Email for statements and box updates <input type="email" name="statements_email" value="${esc(centre.statements_email || '')}" ${dis}><span class="fine">A shared inbox works best here.</span></label>
  ${admin ? '<button class="btn btn-fill">Save</button>' : ''}
</form>
<div class="settings-block" id="team">
  <h2>Team</h2>
  <p>Anyone here can run the closet. Admins can also change settings, invite people and leave the programme. Keep at least two people on it so ${esc(centre.name)} stays reachable when someone moves on.</p>
  ${invitesSent ? '<div class="ok">Invitation sent.</div>' : ''}
  ${admin ? `<form class="row" method="post" action="/settings/team/invite"><label>Invite someone <input type="email" name="email" placeholder="colleague@centre.org" required></label><label>Role <select name="role"><option value="member">Member</option><option value="admin">Admin</option></select></label><button class="btn btn-line">Send invitation</button></form>` : ''}
  <div class="tbl"><table><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Last active</th><th></th></tr></thead><tbody>
  ${team.members.map(m => `<tr><td>${esc(m.name || '')}${m.id === user.id ? ' <span class="fine">you</span>' : ''}${!m.email_verified_at ? ' <span class="pill warn">unverified</span>' : ''}</td><td>${esc(m.email)}</td><td>${m.role === 'admin' ? 'Admin' : 'Member'}</td><td class="soft">${m.last_active_at ? ago(m.last_active_at) : '—'}</td><td>${admin && m.id !== user.id ? `<div class="doors">${m.role !== 'admin' ? `<form method="post" action="/settings/team/${m.id}/role"><input type="hidden" name="role" value="admin"><button class="btn btn-small btn-quiet">Make admin</button></form>` : `<form method="post" action="/settings/team/${m.id}/role"><input type="hidden" name="role" value="member"><button class="btn btn-small btn-quiet">Make member</button></form>`}<form method="post" action="/settings/team/${m.id}/remove" onsubmit="return confirm('Remove ${esc(m.name || m.email)}? They are signed out everywhere.')"><button class="btn btn-small btn-quiet">Remove</button></form></div>` : admin && m.id === user.id && team.members.length > 1 ? `<form method="post" action="/settings/team/handover" onsubmit="return confirm('Hand over admin? You become a member.')"><select name="to">${team.members.filter(x => x.id !== user.id).map(x => `<option value="${x.id}">${esc(x.name || x.email)}</option>`).join('')}</select> <button class="btn btn-small btn-quiet">Hand over admin</button></form>` : ''}</td></tr>`).join('')}
  ${team.invites.map(i => `<tr><td class="soft">Invited</td><td>${esc(i.email)}</td><td>${i.role === 'admin' ? 'Admin' : 'Member'}</td><td class="soft">sent ${ago(i.created_at)}</td><td>${admin ? `<div class="doors"><form method="post" action="/settings/team/invite/${i.id}/resend"><button class="btn btn-small btn-quiet">Resend</button></form><form method="post" action="/settings/team/invite/${i.id}/revoke"><button class="btn btn-small btn-quiet">Revoke</button></form></div>` : ''}</td></tr>`).join('')}
  </tbody></table></div>
  <p class="fine">At least one admin at all times; the last admin must hand over before leaving or being removed. Removing someone signs them out everywhere.</p>
</div>
<div class="settings-block" id="account">
  <h2>Account</h2>
  <form class="row" method="post" action="/settings/account/email"><label>Email <input type="email" name="email" value="${esc(user.email)}" data-nudge-email data-centre-domain="${esc(require('../lib/auth').domainOf(centre.website) || '')}"></label><button class="btn btn-line">Change</button></form>
  <div class="nudge" id="nudge" hidden><span>That looks like a personal address. Got one at the centre?</span><div class="doors"><button type="button" class="btn btn-small btn-line" data-suggest>Use your centre address</button><button type="button" class="btn btn-small btn-quiet" data-keep>Keep this one</button></div></div>
  <p class="fine">Changing it sends a link to the new address; the old one works until you confirm.</p>
  <form class="row" method="post" action="/settings/account/password"><label>Current password <input type="password" name="current" autocomplete="current-password"></label><label>New password <input type="password" name="password" minlength="8" autocomplete="new-password"></label><button class="btn btn-line">Change</button></form>
  <p class="fine">Signed in with email. Google and Microsoft sign-in come later.</p>
</div>
<div class="settings-block" id="leave">
  <h2>Leave the programme</h2>
  <p>Your page comes down, the map listing ends, and anything already raised still ships to you as a final box. Admins only.</p>
  ${admin ? `<form method="post" action="/settings/leave" onsubmit="return confirm('Leave the programme? Your page comes down today.')"><label class="check"><input type="checkbox" name="sure" value="1" required> We understand</label><button class="btn btn-quiet">Leave…</button></form>` : ''}
</div>
</div></div>`;
  return page({ title: `${centre.name} · Settings`, mode: 'centre', centre, user, body, banner: banners({ centre, actingAs }), wide: true });
}

function history({ centre, user, boxes, donations, statements, actingAs }) {
  const body = `
<section><h2>Boxes</h2><div class="tbl"><table><thead><tr><th>Box</th><th>Sent</th><th>Raised</th><th>RUBIES match</th><th>Items</th><th>Requests filled</th><th>Tracking</th></tr></thead><tbody>
${boxes.map(b => `<tr><td><a href="/history/box/${b.number}">#${b.number}</a></td><td>${b.status === 'open' ? '<span class="pill">open</span>' : fmtDate(b.sent_at)}</td><td>${dollars(b.raised)}</td><td>${b.status === 'open' ? '<span class="soft">at shipping</span>' : dollars(b.match)}</td><td>${b.items_count ?? '…'}</td><td>${b.requestsFilled}${b.waiting ? ` + ${b.waiting} waiting` : ''}</td><td class="soft">${b.carrier ? `${esc(b.carrier)} ${esc(b.tracking_number || '')}` : '—'}</td></tr>`).join('')}
</tbody></table></div><p class="fine">Click a box for its contents and the words shared with it.</p></section>
${centre.programmes?.pass_it_on ? `<section><h2>Pass It On donations</h2><div class="tbl"><table><thead><tr><th>Date</th><th>What</th><th>Status</th></tr></thead><tbody>${donations.length ? donations.map(d => `<tr><td>${fmtDate(d.created_at)}</td><td>A customer was given your address for ${d.items_count} item${d.items_count === 1 ? '' : 's'}</td><td class="soft">Sent, as far as we know</td></tr>`).join('') : '<tr><td colspan="3" class="soft">Nothing routed yet.</td></tr>'}</tbody></table></div><p class="fine">We know when a customer is given your address, not when the parcel arrives.</p></section>` : ''}
<section><h2>Statements</h2><p>${statements.length ? statements.map(s => `<a href="/history/statement/${s.month}">${esc(s.month)}</a>`).join(' · ') : '<span class="soft">Only months where something happened.</span>'}</p></section>`;
  return page({ title: `${centre.name} · History`, mode: 'centre', centre, user, body, banner: banners({ centre, actingAs }) });
}

function boxDetail({ centre, user, box, sum, plan, words, actingAs }) {
  const body = `<section><a href="/history">← History</a><h1>Box #${box.number}</h1><p>${box.status === 'open' ? 'Open' : `Sent ${fmtDate(box.sent_at)}`}${box.shipped_at ? `, shipped ${fmtDate(box.shipped_at)}` : ''}${box.delivered_at ? `, arrived ${fmtDate(box.delivered_at)}` : ''}. ${dollars(sum.raised)} raised${box.status !== 'open' ? `, matched ${dollars(sum.raised)}` : ''}.</p>
<h3>Requests</h3>${requestsTable({ centre, requests: sum.requests, role: 'member', byHand: false })}
${plan?.length ? `<h3>The rest of the box</h3><ul class="list">${plan.map(l => `<li>${esc(MENU.find(s => s.key === l.style)?.name || l.style)} · ${esc(l.size)} × ${l.qty}</li>`).join('')}</ul>` : ''}
${words.length ? `<h3>Words shared with it</h3>${words.map(w => `<blockquote>“${esc(w)}”</blockquote>`).join('')}` : ''}</section>`;
  return page({ title: `Box #${box.number}`, mode: 'centre', centre, user, body, banner: banners({ centre, actingAs }) });
}

function sendBox({ centre, user, preview, fillMode = 'auto', pickupNote, deliveryNote, errors = [], actingAs }) {
  const { approved, shipped, remainingBudget, autoPlan, plan, totals, itemsCount } = preview;
  const sizes = centre.sizes || SIZES;
  const chosen = fillMode === 'chosen';
  const gridRows = MENU.map(s => `<tr><td>${esc(s.name)} <span class="fine">${dollars(s.half_cents)}</span></td>${sizes.map(z => { const line = (chosen ? plan : autoPlan).find(l => l.style === s.key && l.size === z); return `<td><input type="number" min="0" name="q_${s.key}_${z}" value="${line ? line.qty : 0}" data-cents="${s.half_cents}" ${chosen ? '' : 'readonly'}></td>`; }).join('')}</tr>`).join('');
  const pickups = approved.filter(r => r.delivery !== 'ship');
  const body = `
<section><p class="soft">Box #${preview.sum.number} · ${preview.sum.funded ? 'funded' : 'not funded yet'}</p><h1>Send box #${preview.sum.number}</h1>${errorBox(errors)}
<form method="post" action="/send" class="form" style="max-width:none">
<h3>1 · Requested items go in first</h3>
<div class="tbl"><table><thead><tr><th>For</th><th>Item</th><th>How</th></tr></thead><tbody>${approved.map(r => `<tr><td>${esc(r.name)}</td><td>${itemsHtml(r.items)}</td><td>${r.delivery === 'ship' ? 'Ships to their door' : 'Pickup'}</td></tr>`).join('') || '<tr><td colspan="3" class="soft">No requests in this box.</td></tr>'}</tbody></table></div>
<p class="fine">These are set. If a colour runs out, RUBIES sends the same style in another colour and the box pays that item's price.</p>
<h3>2 · Fill the rest</h3>
<label class="radio"><input type="radio" name="fill_mode" value="auto" ${!chosen ? 'checked' : ''} onchange="this.form.submit()"> Let it fill itself: RUBIES picks a spread across your sizes and the five styles</label>
<label class="radio"><input type="radio" name="fill_mode" value="chosen" ${chosen ? 'checked' : ''} onchange="this.form.submit()"> Choose the rest</label>
<div class="tbl"><table class="grid-fill" data-budget="${remainingBudget}"><thead><tr><th></th>${sizes.map(z => `<th>${z}</th>`).join('')}</tr></thead><tbody>${gridRows}</tbody></table></div>
<p class="fine" id="remaining">${dollars(Math.max(0, remainingBudget - preview.planCents))} of product left to place</p>
<h3>3 · Totals</h3>
<table style="max-width:480px"><tr><td class="soft">Raised in box #${preview.sum.number}</td><td><b>${dollars(totals.raised)}</b></td></tr><tr><td class="soft">RUBIES match</td><td><b>${dollars(totals.match)}</b></td></tr><tr><td class="soft">Shipping to doors, ${shipped.length} package${shipped.length === 1 ? '' : 's'}</td><td><b>${dollars(totals.doorShipping)}</b></td></tr><tr><td class="soft">Items in the box</td><td><b>${itemsCount}</b></td></tr><tr><td class="soft">Left over, carried to box #${preview.sum.number + 1}</td><td><b>${dollars(totals.carryOut)}</b></td></tr></table>
<p>Ships to: <b>${esc(centre.name)}, ${esc(addressLine(centre))}</b> · <a href="/settings#centre">Change</a></p>
<h3>4 · A note to the people who requested</h3>
<p class="fine">Goes out with their emails. ${pickups.length ? `${pickups.map(p => esc(p.name)).join(' and ')} get${pickups.length === 1 ? 's' : ''} the pickup note the day the carrier delivers the box to you` : 'Nobody is picking up from this box'}${shipped.length ? `; ${shipped.map(p => esc(p.name)).join(' and ')} get${shipped.length === 1 ? 's' : ''} the delivery note now, and tracking from RUBIES when it leaves` : ''}.</p>
<label>For pickup (${pickups.length} ${pickups.length === 1 ? 'person' : 'people'}) <textarea name="pickup_note">${esc(pickupNote)}</textarea></label>
<label>For delivery (${shipped.length} ${shipped.length === 1 ? 'person' : 'people'}) <textarea name="delivery_note">${esc(deliveryNote)}</textarea></label>
<label class="check"><input type="checkbox" name="remember" value="1" checked> Remember these notes for the next box</label>
<p class="fine">Requesters never see each other or any names.</p>
<div class="doors"><button class="btn btn-fill" name="action" value="send" ${preview.sum.funded ? '' : 'disabled'}>Send box #${preview.sum.number}</button><a class="btn btn-quiet" href="/home">Keep it growing instead</a></div>
<p class="fine">Sending closes this box and opens box #${preview.sum.number + 1}.</p>
</form></section>`;
  return page({ title: `Send box #${preview.sum.number}`, mode: 'centre', centre, user, body, banner: banners({ centre, actingAs }), wide: true });
}

function sent({ centre, user, box, nextBox }) {
  const body = `<section class="card narrow"><h1>Box #${box.number} is on its way to RUBIES to be packed.</h1><p>Box #${nextBox.number} is open. People who requested a delivery have been emailed; people picking up will be emailed the day it arrives.</p><a class="btn btn-fill" href="/home">Home</a></section>`;
  return page({ title: 'Sent', mode: 'centre', centre, user, body });
}

function ago(iso) {
  const d = (Date.now() - new Date(iso).getTime()) / 86400000;
  if (d < 1) return 'today';
  if (d < 2) return 'yesterday';
  return `${Math.floor(d)} days ago`;
}

function defaultPickupNote(centre) {
  return centre.pickup_note || `Come to the front desk at ${centre.name}, ${addressLine(centre)}${centre.address?.hours ? `, ${centre.address.hours}` : ''}, and ask for the closet. No need to say what it's for; the desk knows. Nothing to bring.`;
}
function defaultDeliveryNote(centre) {
  return centre.delivery_note || `From everyone at ${centre.name}: enjoy them. If you ever need anything else, you know where we are.`;
}

module.exports = { home, declineForm, settings, history, boxDetail, sendBox, sent, ago, defaultPickupNote, defaultDeliveryNote, requestsTable, LINKS };
