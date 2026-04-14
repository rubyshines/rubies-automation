#!/usr/bin/env node

/**
 * RUBIES Gorgias ↔ CS Advisor Sync Report
 *
 * Uses Gorgias views to reliably fetch all non-closed tickets, then compares
 * with CS Advisor (Supabase) to find sync issues:
 *   - Tickets missing from the Advisor (split by AI-assigned vs legacy)
 *   - Message count mismatches (customer replies Gorgias has but Advisor doesn't)
 *   - Status drift between the two systems
 *
 * Gorgias views used:
 *   28532 "All"        — eq(ticket.status, "open")  (excludes snoozed)
 *   28531 "Unassigned"  — open + no assignee
 *
 * For Advisor-only tickets (open in Advisor, not found in Gorgias views),
 * the script fetches the actual Gorgias ticket to get the real status.
 *
 * Usage:
 *   node customer-service/sync/gorgiasAdvisorSyncReport.js
 */

const path = require('path');
if (!process.env.SUPABASE_URL) {
  require('dotenv').config({ path: path.resolve(__dirname, '../..', '.env') });
}

const { getSupabaseClient } = require('../../shared/supabaseClient');

// Gorgias view IDs (built-in default views)
const VIEW_ALL_OPEN = 28532;    // eq(ticket.status, "open") — excludes snoozed
const VIEW_UNASSIGNED = 28531;  // open + no assignee

// ─── Display helpers ────────────────────────────────────────

function trunc(str, len) {
  if (!str) return '';
  return str.length > len ? str.slice(0, len - 1) + '…' : str;
}

function pad(str, len, align = 'left') {
  str = String(str ?? '');
  if (str.length >= len) return str.slice(0, len);
  return align === 'right' ? str.padStart(len) : str.padEnd(len);
}

function divider(cols) {
  console.log(cols.map(c => '─'.repeat(c)).join('─┼─'));
}

function row(values, cols, aligns) {
  console.log(values.map((v, i) => pad(v, cols[i], aligns?.[i])).join(' │ '));
}

function sts(status) {
  const e = { open: '🟢', snoozed: '💤', closed: '⚫', parked: '🅿️ ', follow_up: '📩' };
  return `${e[status] || '?'} ${status || '—'}`;
}

function section(title, desc, items, printTable) {
  console.log(`\n┌─ ${title}`);
  console.log(`│  ${desc}`);
  if (!items.length) {
    console.log('│  ✓ No issues found');
  } else {
    console.log('│');
    printTable();
  }
  console.log('└' + '─'.repeat(70));
}

// ─── Message counting ───────────────────────────────────────

function countAdvisorMsgs(r) {
  const h = r?.conversation_history;
  if (!Array.isArray(h)) return 0;
  return h.filter(m => m.channel !== 'internal-note').length;
}

function countAdvisorCustomerMsgs(r) {
  const h = r?.conversation_history;
  if (!Array.isArray(h)) return 0;
  return h.filter(m => m.sender === 'customer' && m.channel !== 'internal-note').length;
}

function countGorgiasMsgs(messages) {
  const visible = messages.filter(m => m.channel !== 'internal-note');
  return {
    customer: visible.filter(m => !m.from_agent).length,
    agent: visible.filter(m => m.from_agent).length,
    total: visible.length,
  };
}

// ─── Main ───────────────────────────────────────────────────

async function run() {
  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log('║       RUBIES — Gorgias ↔ CS Advisor Sync Report            ║');
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  if (!process.env.GORGIAS_DOMAIN || !process.env.GORGIAS_API_KEY) {
    console.error('Missing GORGIAS_DOMAIN / GORGIAS_API_KEY — cannot run.');
    process.exit(1);
  }

  const gorgias = require('../import/gorgiasClient');
  const supabase = getSupabaseClient();

  // ── Step 1: Fetch ALL non-closed tickets from Gorgias via views ──

  console.log('Fetching open tickets from Gorgias views...');
  const openTickets = await gorgias.getViewItems(VIEW_ALL_OPEN);
  console.log(`  "All open" view: ${openTickets.length} tickets`);

  const unassignedTickets = await gorgias.getViewItems(VIEW_UNASSIGNED);
  console.log(`  "Unassigned" view: ${unassignedTickets.length} tickets`);

  // Merge + dedup by ticket ID
  const ticketMap = new Map();
  for (const t of [...openTickets, ...unassignedTickets]) {
    if (!t.spam) ticketMap.set(t.id, t);
  }

  // Also check for snoozed tickets — Gorgias views exclude them from "All open"
  // but the raw API returns them as status:"open" with snooze_datetime set.
  // We'll catch these via Advisor-side check below.

  const gorgiasTickets = [...ticketMap.values()];
  console.log(`  Combined (deduped): ${gorgiasTickets.length} tickets\n`);

  // ── Step 2: Fetch messages for each Gorgias ticket ──

  console.log('Fetching messages for each Gorgias ticket...');
  const gorgiasData = new Map();
  for (const t of gorgiasTickets) {
    const messages = await gorgias.getTicketMessages(t.id);
    gorgiasData.set(t.id, { ticket: t, messages, ...countGorgiasMsgs(messages) });
    await gorgias.delay(300);
  }

  // ── Step 3: Fetch matching CS Advisor tickets ──

  console.log('Fetching tickets from CS Advisor...');
  const gorgiasIds = gorgiasTickets.map(t => t.id);

  const ADVISOR_COLS = 'id, gorgias_ticket_id, status, customer_email, customer_name, conversation_history, turn_number, created_at, updated_at, gorgias_status, active_draft_id';

  let advisorMatched = [];
  if (gorgiasIds.length) {
    const batchSize = 200;
    for (let i = 0; i < gorgiasIds.length; i += batchSize) {
      const { data } = await supabase
        .from('cs_tickets').select(ADVISOR_COLS)
        .in('gorgias_ticket_id', gorgiasIds.slice(i, i + batchSize));
      if (data) advisorMatched.push(...data);
    }
  }

  // Find Advisor tickets that are still open but weren't in our Gorgias views
  const { data: advisorOpenNotInViews } = await supabase
    .from('cs_tickets').select(ADVISOR_COLS)
    .in('status', ['open', 'snoozed', 'follow_up'])
    .not('gorgias_ticket_id', 'in', `(${gorgiasIds.length ? gorgiasIds.join(',') : '0'})`);

  const advisorByGorgias = new Map();
  for (const t of advisorMatched) advisorByGorgias.set(t.gorgias_ticket_id, t);

  // ── Step 4: Find RUBIES AI bot ──

  const aiBot = await gorgias.findUser('RUBIES AI');
  const aiBotId = aiBot?.id;

  console.log(`  Advisor matched: ${advisorMatched.length}`);
  console.log(`  Advisor open (not in views): ${(advisorOpenNotInViews || []).length}`);
  console.log(`  RUBIES AI bot ID: ${aiBotId || 'NOT FOUND'}\n`);

  // ═══════════════════════════════════════════════════════════
  //  ANALYSIS — group into 3 sections
  // ═══════════════════════════════════════════════════════════

  const missingFromAdvisor = { aiAssigned: [], legacy: [] };
  const syncDrift = { status: [], messages: [] };
  const advisorDrift = [];

  for (const [gId, gData] of gorgiasData) {
    const g = gData.ticket;
    const a = advisorByGorgias.get(gId);
    const assignee = g.assignee_user;
    const isAi = assignee && aiBotId && assignee.id === aiBotId;

    // ── Missing from Advisor ──
    if (!a) {
      const entry = {
        gorgiasId: gId,
        customer: g.customer?.name || '',
        email: g.customer?.email || '',
        assignee: assignee?.name || '(unassigned)',
        gorgiasStatus: g.status,
        gTotal: gData.total,
        gCustomer: gData.customer,
        isSnoozed: !!g.snooze_datetime,
      };
      if (isAi) missingFromAdvisor.aiAssigned.push(entry);
      else missingFromAdvisor.legacy.push(entry);
      continue;
    }

    // ── Status drift ──
    // Tickets from the "All open" view are genuinely open — trust the view,
    // not snooze_datetime (which may be stale/expired).
    const gStatus = g.status;
    const aStatus = a.status;
    // parked and snoozed are Advisor-only states — Gorgias doesn't know about them.
    // Only flag snoozed if Gorgias is the one showing snoozed (not Advisor-side snooze).
    const advisorOnlyState = aStatus === 'parked' || (aStatus === 'snoozed' && gStatus === 'open');
    if (gStatus !== aStatus && !advisorOnlyState) {
      syncDrift.status.push({
        gorgiasId: gId,
        customer: g.customer?.name || '',
        email: g.customer?.email || '',
        gorgiasStatus: gStatus,
        advisorStatus: aStatus,
        gTotal: gData.total,
        aTotal: countAdvisorMsgs(a),
      });
    }

    // ── Message count drift ──
    const aCust = countAdvisorCustomerMsgs(a);
    if (gData.customer > aCust) {
      syncDrift.messages.push({
        gorgiasId: gId,
        customer: g.customer?.name || '',
        email: g.customer?.email || '',
        gCustomer: gData.customer,
        aCustomer: aCust,
        gTotal: gData.total,
        aTotal: countAdvisorMsgs(a),
      });
    }
  }

  // ── Advisor-only: fetch real Gorgias status for each ──
  for (const t of (advisorOpenNotInViews || [])) {
    let gorgiasStatus = '—', gorgiasAssignee = '—', gTotal = '—', gCustomer = '—';
    if (t.gorgias_ticket_id) {
      try {
        const g = await gorgias.getTicket(t.gorgias_ticket_id);
        gorgiasStatus = g.snooze_datetime ? 'snoozed' : (g.status || '—');
        gorgiasAssignee = g.assignee_user?.name || '(unassigned)';
        await gorgias.delay(300);
        const msgs = await gorgias.getTicketMessages(t.gorgias_ticket_id);
        const counts = countGorgiasMsgs(msgs);
        gTotal = counts.total;
        gCustomer = counts.customer;
        await gorgias.delay(300);
      } catch { gorgiasStatus = 'error'; }
    }
    advisorDrift.push({
      gorgiasId: t.gorgias_ticket_id,
      customer: t.customer_name || '',
      email: t.customer_email || '',
      advisorStatus: t.status,
      gorgiasStatus,
      gorgiasAssignee,
      aTotal: countAdvisorMsgs(t),
      aCustomer: countAdvisorCustomerMsgs(t),
      gTotal,
      gCustomer,
    });

    // Also flag message mismatch if applicable
    const aCust = countAdvisorCustomerMsgs(t);
    if (typeof gCustomer === 'number' && gCustomer > aCust) {
      syncDrift.messages.push({
        gorgiasId: t.gorgias_ticket_id,
        customer: t.customer_name || '',
        email: t.customer_email || '',
        gCustomer,
        aCustomer: aCust,
        gTotal,
        aTotal: countAdvisorMsgs(t),
      });
    }
  }

  // ═══════════════════════════════════════════════════════════
  //  REPORT
  // ═══════════════════════════════════════════════════════════

  const totalIssues =
    missingFromAdvisor.aiAssigned.length + missingFromAdvisor.legacy.length +
    syncDrift.status.length + syncDrift.messages.length +
    advisorDrift.length;

  console.log('════════════════════════════════════════════════════════════════');
  console.log(`  SUMMARY: ${totalIssues} issue(s) found across ${gorgiasTickets.length} Gorgias tickets`);
  console.log('════════════════════════════════════════════════════════════════');

  // ── Section 1: Missing from CS Advisor ──────────────────────

  const allMissing = [...missingFromAdvisor.aiAssigned, ...missingFromAdvisor.legacy];
  section(
    `MISSING FROM CS ADVISOR (${allMissing.length})`,
    'Tickets in Gorgias with no matching cs_tickets row',
    allMissing,
    () => {
      if (missingFromAdvisor.aiAssigned.length) {
        console.log('  ▸ Assigned to RUBIES AI (should have been processed):');
        const cols = [10, 22, 30, 8, 8];
        const heads = ['Ticket#', 'Customer', 'Email', 'G-Msgs', 'G-Cust'];
        const al = ['right', 'left', 'left', 'right', 'right'];
        row(heads, cols, al);
        divider(cols);
        for (const r of missingFromAdvisor.aiAssigned) {
          row([r.gorgiasId, trunc(r.customer, 22), trunc(r.email, 30), r.gTotal, r.gCustomer], cols, al);
        }
      }
      if (missingFromAdvisor.legacy.length) {
        if (missingFromAdvisor.aiAssigned.length) console.log('');
        console.log('  ▸ NOT assigned to RUBIES AI (legacy / manual):');
        const cols = [10, 22, 30, 18, 8];
        const heads = ['Ticket#', 'Customer', 'Email', 'Assignee', 'G-Msgs'];
        const al = ['right', 'left', 'left', 'left', 'right'];
        row(heads, cols, al);
        divider(cols);
        for (const r of missingFromAdvisor.legacy) {
          row([r.gorgiasId, trunc(r.customer, 22), trunc(r.email, 30), trunc(r.assignee, 18), r.gTotal], cols, al);
        }
      }
    }
  );

  // ── Section 2: Sync Drift (in both systems but out of sync) ──

  const allDrift = [...syncDrift.status, ...syncDrift.messages];
  section(
    `SYNC DRIFT — In Both Systems but Out of Sync (${allDrift.length})`,
    'Status or message count differs between Gorgias and CS Advisor',
    allDrift,
    () => {
      if (syncDrift.status.length) {
        console.log('  ▸ Status mismatch:');
        const cols = [10, 22, 30, 14, 14];
        const heads = ['Ticket#', 'Customer', 'Email', 'Gorgias', 'Advisor'];
        row(heads, cols);
        divider(cols);
        for (const r of syncDrift.status) {
          row([r.gorgiasId, trunc(r.customer, 22), trunc(r.email, 30), sts(r.gorgiasStatus), sts(r.advisorStatus)], cols);
        }
      }
      if (syncDrift.messages.length) {
        if (syncDrift.status.length) console.log('');
        console.log('  ▸ Missing customer messages (Gorgias has more than Advisor)');
        console.log('    G/A = Gorgias/Advisor, CustMsg = customer messages only, AllMsg = all messages');
        const cols = [10, 22, 30, 10, 10, 10, 10];
        const heads = ['Ticket#', 'Customer', 'Email', 'G CustMsg', 'A CustMsg', 'G AllMsg', 'A AllMsg'];
        const al = ['right', 'left', 'left', 'right', 'right', 'right', 'right'];
        row(heads, cols, al);
        divider(cols);
        for (const r of syncDrift.messages) {
          row([r.gorgiasId, trunc(r.customer, 22), trunc(r.email, 30), r.gCustomer, r.aCustomer, r.gTotal, r.aTotal], cols, al);
        }
      }
    }
  );

  // ── Section 3: Advisor Still Open — Gorgias Says Otherwise ──

  section(
    `ADVISOR STILL OPEN — Gorgias Disagrees (${advisorDrift.length})`,
    'Open/snoozed in CS Advisor but not in Gorgias open views — actual Gorgias status shown',
    advisorDrift,
    () => {
      const cols = [10, 22, 30, 14, 14, 8, 8];
      const heads = ['Ticket#', 'Customer', 'Email', 'Gorgias', 'Advisor', 'G-Msgs', 'A-Msgs'];
      const al = ['right', 'left', 'left', 'left', 'left', 'right', 'right'];
      row(heads, cols, al);
      divider(cols);
      for (const r of advisorDrift) {
        row([
          r.gorgiasId || '—', trunc(r.customer, 22), trunc(r.email, 30),
          sts(r.gorgiasStatus), sts(r.advisorStatus), r.gTotal, r.aTotal,
        ], cols, al);
      }
    }
  );

  console.log('\n══════════════════════════════════════════════════════════════');
  console.log('  Report complete.');
  console.log('══════════════════════════════════════════════════════════════\n');

  return { missingFromAdvisor, syncDrift, advisorDrift };
}

// ─── Run ────────────────────────────────────────────────────

run().catch(err => {
  console.error('Sync report failed:', err);
  process.exit(1);
});
