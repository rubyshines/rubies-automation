/**
 * autoactionGate.js — kill-switch gate for AUTO-ACTIONS (the operator-action
 * analogue of autosendGate.js).
 *
 * Some actions the advisor proposes are executed AUTOMATICALLY at intake (and by
 * the backstop sweep) with no operator click — today: warehouse holds on
 * unshipped-order changes, and same-country shipping-address edits. Unlike
 * auto-SEND, there is no shadow phase: these are validated, reversible/low-risk
 * behaviors that already run live. This gate exists so Jamie can SEE them in one
 * place and KILL one without a deploy.
 *
 * Two layers, mirroring autosendGate:
 *   1. AUTO_CAPABLE — the only action kinds that can ever auto-execute. Anything
 *      that moves money or is irreversible (refund, cancellation, free_order,
 *      discount_code, exchange, item swaps, ...) is NEVER auto-eligible, full
 *      stop — it is operator-only regardless of any flag.
 *   2. Flags — system_flags, one boolean per capable kind
 *      (`autoaction_<kind>`) plus the master `autoaction_enabled` switch.
 *
 * DEFAULT-ON (opposite of autosend): absence of a flag means ENABLED, because
 * these behaviors are already live and the toggle is a kill switch, not an
 * opt-in. A capable kind only stops auto-executing when its flag (or the master)
 * is explicitly set to false. Reads are still fail-soft via systemFlags — if the
 * DB is unreachable these reversible/validated actions keep running (the
 * intended direction here, unlike a cost/send gate).
 */
const { isFlagEnabled } = require('../../shared/systemFlags');

const MASTER_FLAG = 'autoaction_enabled';
const KIND_FLAG_PREFIX = 'autoaction_';

// Action kinds the system performs autonomously today. These are toggleable.
//  - warehouse_hold: placed at intake + by the reconcile sweep on any
//    unshipped-order change/cancel.
//  - address_change: same-country shipping-address edits applied at intake
//    (a validated slice of order_modification).
const AUTO_CAPABLE = ['warehouse_hold', 'address_change'];

// Everything else is operator-only and can never auto-execute — shown in the
// panel (greyed, "operator only") so the full action surface is visible.
const NEVER_AUTO = [
  'refund', 'cancellation', 'free_order', 'discount_code', 'exchange',
  'exchange+refund', 'order_modification', 'split_shipment',
  'invoice_kept_items', 'order_consolidation', 'customer_profile_update',
];

/**
 * Is a given auto-action kind currently allowed to auto-execute?
 * Default-ON for capable kinds (kill switch), hard-OFF for everything else.
 * @param {string} kind — 'warehouse_hold' | 'address_change'
 * @returns {Promise<boolean>}
 */
async function isAutoactionEnabled(kind) {
  if (!AUTO_CAPABLE.includes(kind)) return false;
  // Master kill switch first, then per-kind. Both default to true (enabled).
  if (!(await isFlagEnabled(MASTER_FLAG, true))) return false;
  return isFlagEnabled(KIND_FLAG_PREFIX + kind, true);
}

// `source` tag written onto each auto-executed actions[] entry so the dashboard
// can tell auto-executions apart from operator-executed ones (which carry no
// source). All values start with `auto_` — that prefix IS the "was this
// automatic?" test.
const SOURCE = {
  HOLD: 'auto_hold',                       // hold placed at intake
  HOLD_SWEEP: 'auto_hold_sweep',           // hold placed by the reconcile sweep
  ADDRESS: 'auto_address',                 // same-country address applied at intake
  ADDRESS_FALLBACK: 'auto_address_fallback', // address couldn't apply → protective hold
};

/** True if an actions[] entry was executed automatically (not by an operator). */
function isAutoSource(source) {
  return typeof source === 'string' && source.startsWith('auto_');
}

/** Map a source tag to the toggle kind it counts against in the panel. */
function kindForSource(source) {
  if (source === SOURCE.ADDRESS) return 'address_change';
  if (isAutoSource(source)) return 'warehouse_hold'; // all other auto sources are holds
  return null;
}

module.exports = {
  MASTER_FLAG,
  KIND_FLAG_PREFIX,
  AUTO_CAPABLE,
  NEVER_AUTO,
  isAutoactionEnabled,
  SOURCE,
  isAutoSource,
  kindForSource,
};
