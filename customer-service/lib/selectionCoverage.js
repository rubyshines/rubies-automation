/**
 * Bot-flow selection coverage check.
 *
 * The Gorgias return flow hands the advisor an explicit itemized list:
 *
 *   Order number: #32590
 *
 *   Selected items:
 *   1x AJ NO-TUCK SHAPING UNDERWEAR - Black / 12
 *   ...
 *   1x SKY NO-TUCK SHAPING ONE-PIECE - Black / 11
 *
 * That list is the scope of the action the customer asked for. The advisor
 * prompt says so, but on 2026-08-10 (ticket 3100) the model relabelled a
 * five-line list as "the AJ and Ruby bottoms" and staged a four-item refund —
 * the dropped line being the only one that wasn't a bottom. Measured across
 * every advisor draft carrying a selection list, this happens on roughly 3% of
 * item-scoped actions: too rare for the scenario suite to tell from noise (the
 * control arm kept all five items 3/3 on a faithful replica), which is the
 * documented case for pairing the prompt rule with a downstream guard.
 *
 * So this is visibility only. It never edits the draft or the action — it
 * raises the ⚠️ prescription.flags banner so the operator reads that one before
 * executing. A narrower action can be perfectly correct (the customer selects
 * five items in the flow, then says in prose they only want two back), which is
 * exactly why this flags rather than blocks.
 *
 * Calibration: run over all 90 historical action drafts carrying a selection
 * list, this criterion fires 3 times, on the 3 genuine drops. Whole-order
 * actions (cancellation, warehouse_hold) legitimately cover every line without
 * naming any, so they are excluded by action type rather than by heuristic.
 * Re-run `node scripts/replaySelectionGuard.js` before changing the matching
 * rules — tune against the population, never against one ticket.
 */

// Item-scoped actions: the operator executes these against a specific list of
// line items, so a dropped line is a real defect. Whole-order actions
// (cancellation, warehouse_hold, order_modification, customer_profile_update,
// discount_code, order_consolidation, split_shipment) are out of scope.
const ITEM_SCOPED_ACTIONS = new Set([
  'refund',
  'exchange',
  'exchange+refund',
  'invoice_kept_items',
]);

// Words that appear across many product titles and so carry no identifying
// signal. What survives is the product name ("SKY", "MIA", "BROOKE") plus the
// occasional distinctive noun ("ONE-PIECE", "SHORTY"), which is what a staged
// action has to mention for the line to count as covered.
const GENERIC_TITLE_WORDS = new Set([
  'THE', 'AND', 'FOR', 'WITH', 'NEW',
  'NO', 'TUCK', 'NOTUCK', 'NO-TUCK',
  'SHAPING', 'EXTRA', 'CUTE', 'SUNNY', 'MAGICAL',
  'BIKINI', 'HALTER', 'TOP', 'TOPS', 'BOTTOM', 'BOTTOMS',
  'UNDERWEAR', 'BRA', 'BRAS', 'TANKINI', 'SHORT', 'SHORTS',
  'SWIMSUIT', 'SUIT', 'RUBIES', 'FREE', 'GIFT', 'SIZE',
]);

/**
 * Pull the "Selected items:" block out of a bot-flow transcript.
 * Returns [] when the text carries no selection list.
 */
function parseBotFlowSelection(text) {
  if (!text || typeof text !== 'string') return [];
  const lines = text.split('\n');
  const start = lines.findIndex((l) => /^\s*Selected items:/i.test(l));
  if (start === -1) return [];

  const items = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) {
      if (items.length) break; // blank line closes the block
      continue;
    }
    if (/^(Total|Order Created|Shipping address|Order number)\s*:/i.test(line)) break;
    const m = line.match(/^(\d+)x\s+(.+?)\s+-\s+(.+)$/);
    if (!m) {
      if (items.length) break; // prose resumed
      continue;
    }
    items.push({
      quantity: Number(m[1]),
      title: m[2].trim(),
      variant: m[3].trim(),
      line,
    });
  }
  return items;
}

/** Distinctive uppercase tokens from a product title. */
function titleTokens(title) {
  return String(title || '')
    .toUpperCase()
    .split(/[^A-Z0-9-]+/)
    .filter((w) => w.length >= 2 && !GENERIC_TITLE_WORDS.has(w));
}

/**
 * Every string the operator would act from: the structured items array, the
 * operator_action_summary the action panel is built from, and the reply prose.
 */
function stagedActionText(structured, composedResponse) {
  const s = structured || {};
  const parts = [
    JSON.stringify((s.intake && s.intake.items) || s.items || []),
    JSON.stringify((s.prescription && s.prescription.items) || []),
    s.operator_action_summary || '',
    composedResponse || '',
  ];
  return parts.join(' \n ').toUpperCase();
}

/**
 * Selected lines whose product is named nowhere in the staged action.
 * A line counts as covered when ANY of its distinctive title tokens appears.
 */
function findUncoveredSelections(selection, structured, composedResponse) {
  if (!selection || !selection.length) return [];
  const haystack = stagedActionText(structured, composedResponse);
  return selection.filter((item) => {
    const tokens = titleTokens(item.title);
    if (!tokens.length) return false; // nothing identifying to test — never flag
    return !tokens.some((t) => haystack.includes(t));
  });
}

/**
 * Full check. Returns { flag } when the operator should look, else {}.
 *
 * @param {string} conversationText  the advisor's issue_description
 * @param {object} structured        buildCompatibleStructured output
 * @param {string} composedResponse  the customer-facing draft
 */
function checkSelectionCoverage(conversationText, structured, composedResponse) {
  const actionType = structured && structured.action_type;
  if (!ITEM_SCOPED_ACTIONS.has(actionType)) return {};

  const selection = parseBotFlowSelection(conversationText);
  if (selection.length < 2) return {}; // nothing to drop from

  const uncovered = findUncoveredSelections(selection, structured, composedResponse);
  if (!uncovered.length) return {};

  const missing = uncovered.map((u) => `${u.quantity}x ${u.title} - ${u.variant}`).join('; ');
  return {
    flag: `⚠️ Selection mismatch: the customer selected ${selection.length} items in the return flow, but the staged ${actionType} does not mention ${missing}. Check the scope before executing.`,
    uncovered,
    selection,
  };
}

module.exports = {
  parseBotFlowSelection,
  findUncoveredSelections,
  checkSelectionCoverage,
  ITEM_SCOPED_ACTIONS,
};
