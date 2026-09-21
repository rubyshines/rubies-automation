// Virtual Closet operator screens (wireframes 2e to 2h). Event delegation only:
// no inline onclick handlers, everything routes through data-action.
(function () {
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const dollars = c => '$' + (Math.round(c || 0) / 100).toLocaleString('en-US', { maximumFractionDigits: 2 });
  const ago = iso => { if (!iso) return '—'; const d = (Date.now() - new Date(iso)) / 86400000; return d < 1 ? 'today' : d < 2 ? 'yesterday' : Math.floor(d) + ' days ago'; };
  const date = iso => iso ? new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '—';
  const VC_BASE = window.__VC_BASE__ || null;

  async function api(path, body) {
    const res = await fetch(path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
    const text = await res.text();
    let data = {}; try { data = text ? JSON.parse(text) : {}; } catch { /* html error */ }
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  }
  function msg(text, isErr) { const m = $('#msg'); m.innerHTML = text ? `<div class="${isErr ? 'err' : 'ok-box'}">${esc(text)}</div>` : ''; if (text) setTimeout(() => { m.innerHTML = ''; }, 6000); }
  function show(tab) { $$('.tab').forEach(s => { s.hidden = s.id !== `tab-${tab}`; }); $$('.vc-nav a').forEach(a => a.classList.toggle('active', a.dataset.tab === tab)); }
  const progs = c => [c.programmes?.closet && 'Closet', c.programmes?.pass_it_on && 'Pass It On'].filter(Boolean).join(' + ') || '—';

  // ---- Needs attention -------------------------------------------------------
  async function renderAttention() {
    show('attention');
    const el = $('#tab-attention'); el.innerHTML = '<p class="soft">Loading…</p>';
    const a = await api('/api/closets/attention');
    const w = a.week;
    el.innerHTML = `
      ${a.newCentres.length ? `<h2>New centres to review · ${a.newCentres.length} <span class="soft">oldest first</span></h2>${a.newCentres.map(c => `<div class="card" id="centre-${c.id}"><div class="row"><b>${esc(c.name)}</b>${c.address?.city ? `, ${esc(c.address.city)}` : ''} <span class="soft">· ${progs(c)} · signed up ${c.ageDays} days ago · admin ${esc(c.admin?.email || '?')} ${c.verified ? '<span class="pill ok">verified</span>' : '<span class="pill warn">not yet verified</span>'}</span></div><div class="row" style="margin-top:6px"><button class="primary" data-action="approve" data-id="${c.id}" ${c.verified ? '' : 'disabled title="Approve is disabled until the admin\'s email is verified"'}>Approve</button><button data-action="ask" data-id="${c.id}">Ask for more</button><button class="quiet" data-action="decline" data-id="${c.id}">Decline</button><a class="btn" href="#centre-${c.id}" data-action="open-centre" data-id="${c.id}">Open</a></div></div>`).join('')}` : ''}
      ${a.boxesToPack.length ? `<h2>Boxes to pack · ${a.boxesToPack.length}</h2>${a.boxesToPack.map(b => `<div class="card" id="box-${b.id}"><div class="row"><b>${esc(b.centre?.name)}</b> · box #${b.number} · sent ${ago(b.sent_at)} <span class="soft">· ${b.items_count || '?'} items</span> <button data-action="packing" data-id="${b.id}">Open packing list</button></div></div>`).join('')}` : ''}
      ${a.waitingOn.length ? `<h2>Waiting on a centre</h2>${a.waitingOn.map(x => `<div class="card"><div class="row">${esc(x.text)} <a class="btn" href="#centre-${x.centre.id}" data-action="open-centre" data-id="${x.centre.id}">Open</a></div></div>`).join('')}` : ''}
      ${a.reports.length ? `<h2 id="reports">Reported words · ${a.reports.length}</h2>${a.reports.map(r => `<div class="card"><div class="row">${esc(r.centre)}'s page: “${esc(r.words)}” <span class="soft">· reported ${ago(r.reported_at)}</span> <button data-action="report" data-id="${r.id}" data-res="unpublish">Unpublish</button><button class="quiet" data-action="report" data-id="${r.id}" data-res="keep">Keep</button></div></div>`).join('')}` : ''}
      <h2>This week</h2>
      <div class="kpis"><div class="kpi"><b>${w.activeCentres}</b><span>Active centres</span></div><div class="kpi"><b>${w.orders}</b><span>Orders from closet links</span></div><div class="kpi"><b>${dollars(w.sponsoredCents)}</b><span>Sponsored</span></div><div class="kpi"><b>${w.requests}</b><span>Requests</span></div><div class="kpi"><b>${w.boxesShipped}</b><span>Boxes shipped</span></div><div class="kpi"><b>${dollars(w.matchOwedCents)}</b><span>Match owed on open boxes</span></div></div>
      ${a.unusual.length ? `<h2>Unusual</h2><ul>${a.unusual.map(u => `<li>${esc(u)}</li>`).join('')}</ul>` : ''}
      ${!a.newCentres.length && !a.boxesToPack.length && !a.waitingOn.length && !a.reports.length ? '<p class="empty">Nothing needs a human right now.</p>' : ''}`;
  }

  // ---- Centres ------------------------------------------------------------------
  let centresFilter = 'active';
  async function renderCentres() {
    show('centres');
    const el = $('#tab-centres'); el.innerHTML = '<p class="soft">Loading…</p>';
    const all = await api('/api/closets/centres');
    const counts = { active: 0, pending: 0, paused: 0, left: 0 };
    all.forEach(c => { counts[c.status] = (counts[c.status] || 0) + 1; });
    const q = ($('#centres-q')?.value || '').toLowerCase();
    const rows = all.filter(c => (centresFilter === 'all' || c.status === centresFilter) && (!q || c.name.toLowerCase().includes(q) || (c.address?.city || '').toLowerCase().includes(q)));
    el.innerHTML = `<h2>Centres · ${all.length}</h2>
      <div class="row"><div class="tabs">${['active', 'pending', 'paused', 'left', 'all'].map(f => `<button data-action="centres-filter" data-f="${f}" class="${centresFilter === f ? 'active' : ''}">${f === 'pending' ? 'Waiting' : f[0].toUpperCase() + f.slice(1)}${counts[f] != null ? ` · ${counts[f]}` : ''}</button>`).join('')}</div><input type="text" id="centres-q" placeholder="Search" value="${esc(q)}"></div>
      <table><thead><tr><th>Centre</th><th>Programmes</th><th>Box</th><th>Requests</th><th>Orders, 30d</th><th>Last sign-in</th><th></th></tr></thead><tbody>
      ${rows.map(c => `<tr><td><b>${esc(c.name)}</b>${c.address?.city ? `, ${esc(c.address.city)}` : ''}<br><span class="soft">${c.status}${c.admins === 1 ? ' · one admin' : ''}</span></td><td>${progs(c)}</td><td>${c.mode === 'link' ? `<span class="pill">link</span> balance ${dollars(c.balance?.balanceCents || 0)} · raised ${dollars(c.balance?.raisedCents || 0)}` : c.box ? `#${c.box.number} · ${dollars(c.box.raised)} / ${dollars(c.box.goal)}${c.box.funded ? ' <span class="pill ok">funded, not sent</span>' : ''}` : '—'}</td><td>${c.box ? c.box.approved : '—'}${c.unanswered ? ` <span class="pill warn">${c.unanswered} unanswered</span>` : ''}${c.box?.waiting ? ` <span class="soft">+${c.box.waiting} waiting</span>` : ''}</td><td>${c.orders30d}</td><td>${ago(c.lastSignIn)}</td><td><a class="btn" href="#centre-${c.id}" data-action="open-centre" data-id="${c.id}">Open</a></td></tr>`).join('') || '<tr><td colspan="7" class="empty">No centres.</td></tr>'}
      </tbody></table>`;
    $('#centres-q').addEventListener('input', () => renderCentres());
  }

  // ---- Centre detail -----------------------------------------------------------------
  async function renderCentre(id) {
    show('centre');
    const el = $('#tab-centre'); el.innerHTML = '<p class="soft">Loading…</p>';
    const d = await api(`/api/closets/centres/${id}`);
    const c = d.centre;
    const open = d.boxes.find(b => b.status === 'open');
    const s = c.address || {};
    el.innerHTML = `<p><a href="#centres" data-action="tab" data-tab="centres">Centres</a> › ${esc(c.name)}</p>
      <h2 style="margin-top:4px">${esc(c.name)} <span class="pill ${c.status === 'active' ? 'ok' : c.status === 'pending' ? 'warn' : 'bad'}">${c.status}</span></h2>
      <p class="soft">${esc(s.city || '')}${s.region ? `, ${esc(s.region)}` : ''} · ${c.website ? `<a href="${esc(c.website)}" target="_blank" rel="noopener">${esc(c.website.replace(/^https?:\/\//, ''))}</a>` : 'no website'} · ${progs(c)}${c.approved_at ? ` · approved ${date(c.approved_at)} by ${esc(c.approved_by || '')}` : ''} · slug <code>${esc(c.slug)}</code></p>
      <div class="row no-print">
        <button data-action="open-as" data-id="${c.id}">Open their Home as them</button>
        <a class="btn" href="mailto:${esc(d.team.members.filter(m => m.role === 'admin').map(m => m.email).join(','))}">Email admins</a>
        ${c.status === 'pending' ? `<button class="primary" data-action="approve" data-id="${c.id}">Approve</button><button data-action="ask" data-id="${c.id}">Ask for more</button><button class="quiet" data-action="decline" data-id="${c.id}">Decline</button>` : ''}
        ${c.status === 'active' ? `<button class="quiet" data-action="pause-centre" data-id="${c.id}">Pause centre…</button>` : c.status === 'paused' ? `<button data-action="resume-centre" data-id="${c.id}">Resume centre</button>` : ''}
      </div>
      <div class="tabs">${['overview', 'boxes', 'requests', 'team', 'settings', 'words', 'log'].map((t, i) => `<button data-action="ctab" data-t="${t}" class="${i === 0 ? 'active' : ''}">${t[0].toUpperCase() + t.slice(1)}</button>`).join('')}</div>
      <div class="detail show" data-ctab="overview">
        ${d.balance ? `<div class="card"><b>Link mode</b> · balance ${dollars(d.balance.balanceCents)} · raised ${dollars(d.balance.raisedCents)} · redeemed ${dollars(d.balance.redeemedCents)} · ${d.balance.orders} orders, ${d.balance.sponsors} sponsors<br><span class="soft">Redeem and adjust with the vc_redeem tool. Notification email: ${esc(c.statements_email || '')}</span></div>` : ''}
        ${open ? `<div class="card"><b>Box #${open.number} · open</b> · ${dollars(open.raised)} of ${dollars(open.goal)} · ${open.requests} requests · orders ${dollars(open.sources.orders)}, sponsors ${dollars(open.sources.sponsors)}, centre ${dollars(open.sources.centre)}<br><span class="soft">Carried in: ${dollars(open.sources.carry)}</span><div class="row" style="margin-top:6px"><input type="number" id="rubies-add" placeholder="$" style="width:80px"><button data-action="add-rubies" data-id="${c.id}">Add to box as RUBIES</button></div></div>` : '<p class="empty">No open box.</p>'}
        <div class="card"><b>Requests</b> · approved in the open box ${d.requests.filter(r => ['approved', 'in_box'].includes(r.status)).length} · waiting for the next box ${d.requests.filter(r => r.status === 'waiting').length} · declined, all time ${d.requests.filter(r => r.status === 'declined').length} · approval mode ${c.approval_mode === 'by_hand' ? 'by hand' : 'automatic'}</div>
        <div class="card"><b>Links</b> · codes issued ${d.codes.issued}, used ${d.codes.used} · visits (90d) ${d.visits} · words published ${d.published}</div>
      </div>
      <div class="detail" data-ctab="boxes"><table><thead><tr><th>Box</th><th>Status</th><th>Raised</th><th>Goal</th><th>Requests</th><th>Sent</th><th>Tracking</th><th></th></tr></thead><tbody>${d.boxes.map(b => `<tr><td>#${b.number}</td><td>${b.status}</td><td>${dollars(b.raised)}</td><td>${dollars(b.goal)}</td><td>${b.requests}</td><td>${date(b.sent_at)}</td><td>${esc(b.carrier || '')} ${esc(b.tracking_number || '')}</td><td>${b.status !== 'open' ? `<button data-action="packing" data-id="${b.id}">Packing list</button>` : ''}</td></tr>`).join('')}</tbody></table></div>
      <div class="detail" data-ctab="requests"><p class="soft">Full detail including delivery addresses; the only place they are visible.</p><table><thead><tr><th>When</th><th>Name</th><th>Email</th><th>Items</th><th>How</th><th>Status</th><th></th></tr></thead><tbody>${d.requests.map(r => `<tr><td>${ago(r.created_at)}</td><td>${esc(r.name)}</td><td>${esc(r.email)}</td><td>${esc(r.items_text)}</td><td>${r.delivery}${r.address ? `<br><span class="soft">${esc([r.address.street, r.address.city, r.address.region, r.address.postal].filter(Boolean).join(', '))}</span>` : ''}</td><td>${esc(r.status_label)}</td><td><button class="quiet" data-action="request" data-id="${r.id}">Open</button></td></tr>`).join('') || '<tr><td colspan="7" class="empty">No requests.</td></tr>'}</tbody></table></div>
      <div class="detail" data-ctab="team"><table><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Verified</th><th>Last active</th></tr></thead><tbody>${d.team.members.map(m => `<tr><td>${esc(m.name || '')}</td><td>${esc(m.email)}</td><td>${m.role}</td><td>${m.email_verified_at ? 'yes' : 'no'}</td><td>${ago(m.last_active_at)}</td></tr>`).join('')}${d.team.invites.map(i => `<tr><td class="soft">invited</td><td>${esc(i.email)}</td><td>${i.role}</td><td>—</td><td>sent ${ago(i.created_at)}</td></tr>`).join('')}</tbody></table></div>
      <div class="detail" data-ctab="settings"><p>Sizes ${esc((c.sizes || []).join(', '))}${c.kids_sizes ? ', kids' : ''} · ${c.items_per_request} items per request · ${c.requests_per_year} requests a year · goal ${dollars(c.goal_cents)} · ${c.approval_mode === 'by_hand' ? 'by-hand' : 'automatic'} approval · shipping to door ${c.ship_to_door ? 'on' : 'off'} · requests ${c.requests_paused_at ? 'paused' : 'open'} · map ${c.map_listed ? 'listed' : 'not listed'}${c.map_pin_to_closet ? ', pin → closet' : ''}</p><p class="soft">Change any of these on their behalf: each edit is logged and emailed to their admins.</p><div class="row"><label>Goal $ <input type="number" id="ov-goal" value="${Math.round(c.goal_cents / 100)}" min="300" style="width:90px"></label><label>Items per request <input type="number" id="ov-items" value="${c.items_per_request}" min="1" max="6" style="width:60px"></label><label>Requests a year <input type="number" id="ov-year" value="${c.requests_per_year}" min="1" max="12" style="width:60px"></label><label>Approval <select id="ov-mode"><option value="automatic" ${c.approval_mode === 'automatic' ? 'selected' : ''}>automatic</option><option value="by_hand" ${c.approval_mode === 'by_hand' ? 'selected' : ''}>by hand</option></select></label><label>Requests <select id="ov-paused"><option value="0" ${!c.requests_paused_at ? 'selected' : ''}>open</option><option value="1" ${c.requests_paused_at ? 'selected' : ''}>paused</option></select></label><button data-action="override" data-id="${c.id}">Save on their behalf</button></div></div>
      <div class="detail" data-ctab="words">${d.requests.filter(r => r.words).map(r => `<div class="card">“${esc(r.words)}” <span class="soft">· ${esc(r.name)} · ${r.words_published_at ? '<span class="pill ok">published</span>' : r.words_shareable ? 'shareable, not published' : 'private'}</span></div>`).join('') || '<p class="empty">No words yet.</p>'}</div>
      <div class="detail" data-ctab="log"><ul class="log">${d.events.map(e => `<li><span class="soft">${date(e.created_at)}</span> · ${esc(e.actor)} · ${esc(e.kind)}${e.detail && Object.keys(e.detail).length ? ` <span class="soft">${esc(JSON.stringify(e.detail))}</span>` : ''}</li>`).join('') || '<li class="empty">Nothing logged.</li>'}</ul></div>`;
  }

  // ---- Boxes and packing --------------------------------------------------------------
  let boxesFilter = 'sent';
  async function renderBoxes() {
    show('boxes');
    const el = $('#tab-boxes'); el.innerHTML = '<p class="soft">Loading…</p>';
    const rows = await api(`/api/closets/boxes${boxesFilter === 'all' ? '' : `?status=${boxesFilter}`}`);
    el.innerHTML = `<h2>Boxes</h2><div class="tabs">${[['sent', 'To pack'], ['shipped', 'Shipped'], ['open', 'Open'], ['delivered', 'Delivered'], ['all', 'All']].map(([f, l]) => `<button data-action="boxes-filter" data-f="${f}" class="${boxesFilter === f ? 'active' : ''}">${l}</button>`).join('')}</div>
      <table><thead><tr><th>Box</th><th>Centre</th><th>Sent by centre</th><th>Raised</th><th>Match</th><th>Items</th><th>Status</th><th></th></tr></thead><tbody>${rows.map(b => `<tr id="box-${b.id}"><td>#${b.number}</td><td>${esc(b.centre?.name)}</td><td>${date(b.sent_at)}</td><td>${dollars(b.raised)}</td><td>${dollars(b.match)}</td><td>${b.items_count ?? '—'}</td><td>${b.status}${b.tracking_number ? ` · ${esc(b.carrier || '')} ${esc(b.tracking_number)}` : ''}</td><td>${b.status !== 'open' ? `<button data-action="packing" data-id="${b.id}">Packing list</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="8" class="empty">No boxes.</td></tr>'}</tbody></table>`;
  }

  async function renderPacking(id) {
    show('packing');
    const el = $('#tab-packing'); el.innerHTML = '<p class="soft">Loading…</p>';
    const p = await api(`/api/closets/boxes/${id}/packing`);
    const a = p.centre.address || {};
    const sizes = p.sizes || [];
    const styles = [...new Set(p.plan.map(l => l.style))];
    el.innerHTML = `<p class="no-print"><a href="#boxes" data-action="tab" data-tab="boxes">Boxes</a> › ${esc(p.centre.name)} box #${p.box.number}</p>
      <h2>Packing list · ${esc(p.centre.name)} box #${p.box.number} <span class="pill">${p.box.status}</span></h2>
      <div class="row no-print"><button data-action="print">Print</button><button class="quiet" disabled title="Zero-priced store orders per requester: not built yet">Create store orders</button>
        ${p.box.status === 'sent' ? `<input type="text" id="ship-carrier" placeholder="Carrier" style="width:110px"><input type="text" id="ship-tracking" placeholder="Tracking" style="width:180px"><button class="primary" data-action="shipped" data-id="${p.box.id}">Mark shipped, add tracking</button>` : ''}
        ${p.box.status === 'shipped' ? `<button class="primary" data-action="delivered" data-id="${p.box.id}">Carrier delivered it</button>` : ''}</div>
      <p><b>Ship to:</b> ${esc(p.centre.name)}, ${esc([a.street, a.city, a.region, a.postal].filter(Boolean).join(', '))}${p.admin ? ` · attn ${esc(p.admin.name || p.admin.email)}` : ''}${a.phone ? ` · ${esc(a.phone)}` : ''}</p>
      <h3>Requested items, ${p.requests.length} people <span class="soft">(bag separately, label with the name they go by)</span></h3>
      <table><thead><tr><th>For</th><th>Items</th><th>Where</th></tr></thead><tbody>${p.requests.map(r => `<tr><td><b>${esc(r.name)}</b></td><td>${r.items.map(i => `${esc(i.styleName)} · ${esc(i.colour)} · ${esc(i.size)}${i.storeSize && i.storeSize !== i.size ? ` <span class="soft">(shelf size ${esc(i.storeSize)})</span>` : ''}`).join('<br>')}${r.swap ? `<br><span class="soft">swapped from ${esc(r.swap.from?.colour)}</span>` : ''}</td><td>${r.delivery === 'ship' ? `separate parcel to ${esc([r.address?.street, r.address?.city, r.address?.region, r.address?.postal].filter(Boolean).join(', '))}, plain packaging` : 'in box'}</td></tr>`).join('') || '<tr><td colspan="3" class="empty">No requests in this box.</td></tr>'}</tbody></table>
      <p class="soft">Out of stock? Swap colour within the same style; the new price is the price. Log the swap on the request; the requester's "on its way" email names the colour sent.</p>
      <h3>Fill, ${p.plan.reduce((n, l) => n + l.qty, 0)} items <span class="soft">· centre chose "${p.box.fill_mode === 'chosen' ? 'choose the rest' : 'let it fill itself'}"</span></h3>
      <table class="grid-fill"><thead><tr><th></th>${sizes.map(z => `<th>${z}</th>`).join('')}</tr></thead><tbody>${styles.map(st => `<tr><td style="text-align:left">${esc(p.plan.find(l => l.style === st).styleName)}</td>${sizes.map(z => `<td>${p.plan.find(l => l.style === st && l.size === z)?.qty || 0}</td>`).join('')}</tr>`).join('') || '<tr><td class="empty">Nothing to fill.</td></tr>'}</tbody></table>
      <p><b>Totals:</b> raised ${dollars(p.totals.raised)} + match ${dollars(p.totals.match)} − door shipping ${dollars(p.totals.doorShipping)} = ${dollars(p.totals.productBudget)} · items ${dollars(p.totals.placedProductCents)} · ${dollars(p.totals.carryOut)} carries to the next box</p>
      <p class="soft">Mark shipped sends "box is on its way" to the centre and the delivery-requester emails; pickup emails wait for carrier delivery.</p>`;
  }

  // ---- Requests -------------------------------------------------------------------------
  let reqFilter = 'open';
  async function renderRequests() {
    show('requests');
    const el = $('#tab-requests'); el.innerHTML = '<p class="soft">Loading…</p>';
    const q = $('#req-q')?.value || '';
    const rows = await api(`/api/closets/requests?status=${reqFilter === 'all' ? '' : reqFilter}&q=${encodeURIComponent(q)}`);
    el.innerHTML = `<h2>Requests</h2><div class="row"><div class="tabs">${[['open', 'In open boxes'], ['needs_answer', "Waiting for a centre's answer"], ['shipped', 'Shipped'], ['ready', 'Ready'], ['declined', 'Declined'], ['ended', 'Ended'], ['all', 'All']].map(([f, l]) => `<button data-action="req-filter" data-f="${f}" class="${reqFilter === f ? 'active' : ''}">${l}</button>`).join('')}</div><input type="text" id="req-q" placeholder="Search email or name" value="${esc(q)}"></div>
      <table><thead><tr><th>When</th><th>Centre</th><th>Name</th><th>Email</th><th>Items</th><th>How</th><th>Status</th><th></th></tr></thead><tbody>${rows.map(r => `<tr><td>${ago(r.created_at)}</td><td>${esc(r.centre?.name)}${r.centre?.status === 'left' ? ' <span class="soft">(left)</span>' : ''}</td><td>${esc(r.name)}</td><td>${esc(r.email.replace(/^(.).*@/, '$1…@'))}</td><td>${esc(r.items_text)}</td><td>${r.delivery}</td><td>${esc(r.status_label)}</td><td><button class="quiet" data-action="request" data-id="${r.id}">Open</button></td></tr>`).join('') || '<tr><td colspan="8" class="empty">No requests.</td></tr>'}</tbody></table>
      <div id="req-detail"></div>`;
    $('#req-q').addEventListener('change', () => renderRequests());
  }

  async function renderRequest(id) {
    const d = await api(`/api/closets/requests/${id}`);
    const r = d.request, a = r.address || {};
    let host = $('#req-detail'); if (!host || host.closest('.tab').hidden) { await renderRequests(); host = $('#req-detail'); }
    host.innerHTML = `<div class="card"><div class="row"><b>Request · ${esc(r.name)} · ${esc(d.centre.name)}${d.box ? ` · box #${d.box.number}` : ''}</b><button class="quiet" data-action="close-request" style="margin-left:auto">✕</button></div>
      <p><b>Items</b><br>${r.items.map((i, idx) => `${esc(i.styleName)} · ${esc(i.colour)} · ${esc(i.size)} <button class="quiet" data-action="swap" data-id="${r.id}" data-index="${idx}">Change item (swap)</button>`).join('<br>')}</p>
      <p><b>Delivery</b> ${r.delivery === 'ship' ? `<br>${esc([a.street, a.city, a.region, a.postal].filter(Boolean).join(', '))}<br><span class="soft">Visible to operator only.</span>` : 'pickup at the centre'}</p>
      <p><b>Email</b> ${esc(r.email)}${r.verified_at ? ` · confirmed ${date(r.verified_at)}` : ''} · requests from this email: ${d.yearCount} of ${d.centre.requests_per_year} this year at ${esc(d.centre.name)}</p>
      <p><b>Words</b> ${r.words ? `“${esc(r.words)}”` : 'none'}</p>
      <p><b>Timeline</b><br>${d.events.map(e => `${date(e.created_at)} · ${esc(e.kind)}`).join('<br>') || '—'}</p>
      ${!['cancelled', 'ended', 'collected', 'shipped'].includes(r.status) ? `<div class="row"><button class="quiet" data-action="cancel-request" data-id="${r.id}">Cancel request…</button></div>` : ''}
      <p class="soft">The only screen where email and address appear together. Cancel needs an internal reason and sends nothing unless you tick "email them". Nothing here ever writes back about someone's words.</p></div>`;
    host.scrollIntoView({ behavior: 'smooth' });
  }

  // ---- actions ------------------------------------------------------------------------------
  document.addEventListener('click', async (e) => {
    const t = e.target.closest('[data-action]'); if (!t) return;
    const id = t.dataset.id; const act = t.dataset.action;
    try {
      switch (act) {
        case 'tab': e.preventDefault(); route(t.dataset.tab); break;
        case 'open-centre': e.preventDefault(); location.hash = `centre-${id}`; break;
        case 'ctab': $$('[data-ctab]').forEach(d => d.classList.toggle('show', d.dataset.ctab === t.dataset.t)); $$('[data-action="ctab"]').forEach(b => b.classList.toggle('active', b === t)); break;
        case 'centres-filter': centresFilter = t.dataset.f; renderCentres(); break;
        case 'boxes-filter': boxesFilter = t.dataset.f; renderBoxes(); break;
        case 'req-filter': reqFilter = t.dataset.f; renderRequests(); break;
        case 'approve': if (!confirm('Approve this centre? Their page goes live and the welcome email is sent.')) return; await api(`/api/closets/centres/${id}/approve`, {}); msg('Approved.'); route(); break;
        case 'ask': { const m = prompt('What do you want to ask them?'); if (!m) return; await api(`/api/closets/centres/${id}/ask`, { message: m }); msg('Sent.'); break; }
        case 'decline': { const reason = prompt('One line of reason, kept internal:'); if (reason == null) return; await api(`/api/closets/centres/${id}/decline`, { reason }); msg('Declined.'); route(); break; }
        case 'pause-centre': { const reason = prompt('Why pause? (shown to the centre)'); if (reason == null) return; await api(`/api/closets/centres/${id}/pause`, { reason }); msg('Paused.'); renderCentre(id); break; }
        case 'resume-centre': await api(`/api/closets/centres/${id}/resume`, {}); msg('Resumed.'); renderCentre(id); break;
        case 'override': await api(`/api/closets/centres/${id}/settings`, { goal_cents: (parseInt($('#ov-goal').value, 10) || 300) * 100, items_per_request: parseInt($('#ov-items').value, 10) || 2, requests_per_year: parseInt($('#ov-year').value, 10) || 2, approval_mode: $('#ov-mode').value, requests_paused_at: $('#ov-paused').value === '1' ? new Date().toISOString() : null }); msg('Saved and emailed to their admins.'); renderCentre(id); break;
        case 'add-rubies': { const d = parseFloat($('#rubies-add').value); if (!d) return; const note = prompt('Note for the log:') || ''; await api(`/api/closets/centres/${id}/add`, { dollars: d, note }); msg('Added.'); renderCentre(id); break; }
        case 'open-as': { const r = await api(`/api/closets/centres/${id}/open-as`, {}); window.open(r.url, '_blank'); break; }
        case 'packing': e.preventDefault(); location.hash = `packing-${id}`; break;
        case 'print': window.print(); break;
        case 'shipped': await api(`/api/closets/boxes/${id}/shipped`, { carrier: $('#ship-carrier').value, tracking: $('#ship-tracking').value }); msg('Marked shipped; emails sent.'); renderPacking(id); break;
        case 'delivered': if (!confirm('Mark delivered? Pickup-ready emails go out now.')) return; await api(`/api/closets/boxes/${id}/delivered`, {}); msg('Marked delivered; emails sent.'); renderPacking(id); break;
        case 'request': renderRequest(id); break;
        case 'close-request': $('#req-detail').innerHTML = ''; break;
        case 'swap': { const colour = prompt('New colour (blank to keep):') || undefined; const size = prompt('New size (blank to keep):') || undefined; if (!colour && !size) return; await api(`/api/closets/requests/${id}/swap`, { index: t.dataset.index, colour, size }); msg('Swapped and logged.'); renderRequest(id); break; }
        case 'cancel-request': { const reason = prompt('Internal reason:'); if (!reason) return; const emailThem = confirm('Email them a short note? OK = yes, Cancel = no email.'); await api(`/api/closets/requests/${id}/cancel`, { reason, email_them: emailThem }); msg('Cancelled.'); renderRequests(); break; }
        case 'report': await api(`/api/closets/reports/${id}/resolve`, { resolution: t.dataset.res }); msg(t.dataset.res === 'unpublish' ? 'Unpublished.' : 'Kept.'); renderAttention(); break;
        default: break;
      }
    } catch (err) { msg(err.message, true); }
  });

  function route(tab) {
    const h = tab || (location.hash || '#attention').slice(1);
    let m;
    if ((m = h.match(/^centre-(\d+)$/))) return renderCentre(m[1]);
    if ((m = h.match(/^packing-(\d+)$/))) return renderPacking(m[1]);
    if ((m = h.match(/^box-(\d+)$/))) return renderPacking(m[1]);
    if (h === 'centres') return renderCentres();
    if (h === 'boxes') return renderBoxes();
    if (h === 'requests') return renderRequests();
    return renderAttention();
  }
  window.addEventListener('hashchange', () => route());
  route();
})();
