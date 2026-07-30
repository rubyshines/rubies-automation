/**
 * advisorOutputSchema.js — enforced output schema for the CS advisor (#2).
 *
 * Replaces the prose+<structured>-block convention (model asked nicely to emit
 * JSON inside text, hand-parsed with regex) with API-enforced structured
 * output (`output_config.format`): the model's final message IS this JSON,
 * guaranteed valid. Eliminates the parse-failure class and the
 * stripInternalThinking band-aid (reasoning can't leak around a schema).
 *
 * customer_reply is deliberately the FIRST property: the API generates fields
 * in schema order, so the customer-facing email streams first and the SSE
 * path can surface it live (see createCustomerReplyStreamExtractor).
 *
 * Field semantics are carried in `description`s — they were prompt text
 * before; the model sees them either way.
 */

const ADVISOR_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    customer_reply: {
      type: 'string',
      description: "The actual email response to send to the customer, written as Jamie emailing them directly. ONLY the email body — no preamble, no narration of your process, no JSON, no signature beyond how Jamie naturally signs. This is exactly what the customer will read.",
    },
    status: {
      type: 'string',
      enum: ['ready', 'needs_info', 'gathering', 'route_to_human'],
      description: "Use ready when ALL items are resolved OR when setting an explicit action_type (the system automatically marks it action_needed for the operator). Use needs_info when waiting on customer input. Use gathering while still processing.",
    },
    message_type: {
      type: 'string',
      enum: ['exchange', 'refund', 'defect', 'sizing_inquiry', 'shipping', 'closing', 'general_inquiry', 'business_outreach', 'community_outreach', 'discount_request', 'uncategorized'],
      description: "Always pick the single best-fit value. business_outreach = unsolicited B2B sales/marketing emails. community_outreach = LGBTQ+ org partnerships. discount_request = customer asks for a discount or missing welcome code. If nothing fits use 'uncategorized' — never invent new values.",
    },
    customer_intent: {
      enum: ['exchange_same_product', 'exchange_different_product', 'refund', 'unsure', null],
      description: 'What the customer is trying to achieve, or null if not applicable.',
    },
    action_type: {
      // free_order is mandated by the advisor prompt (send-at-no-charge with no
      // return story) and accepted by the legacy parser — it was missing from
      // this enforced enum, so schema mode could never emit it.
      enum: [null, 'warehouse_hold', 'order_modification', 'cancellation', 'customer_profile_update', 'discount_code', 'split_shipment', 'invoice_kept_items', 'free_order'],
      description: 'Set when an order, profile, discount-code, split-shipment, invoice-kept-items, or free-order action is needed beyond exchange/refund. Otherwise null.',
    },
    action_order_number: {
      anyOf: [{ type: 'string' }, { type: 'null' }],
      description: "The order number the staged action targets, digits only (e.g. '31485'). REQUIRED whenever action_type is set or operator_action_summary names an order — usually the loaded order, but when the operator or customer redirects the action to a DIFFERENT order, put THAT order's number here (automatic actions like warehouse holds execute against this order). Null when there is no action.",
    },
    new_address: {
      anyOf: [
        { type: 'null' },
        {
          type: 'object',
          properties: {
            address1: { type: 'string' },
            city: { type: 'string' },
            province: { type: 'string' },
            zip: { type: 'string' },
            country: { type: 'string' },
          },
          required: ['address1', 'city'],
          additionalProperties: false,
        },
      ],
      description: 'REQUIRED when action_type is order_modification and the customer provided a new shipping address — parse it from their message. Otherwise null.',
    },
    customer_profile_update: {
      anyOf: [
        { type: 'null' },
        {
          type: 'object',
          properties: {
            new_email: { type: 'string' },
            new_first_name: { type: 'string' },
            new_last_name: { type: 'string' },
          },
          additionalProperties: false,
        },
      ],
      description: 'REQUIRED when action_type is customer_profile_update. Include only the fields the customer asked to change. Otherwise null.',
    },
    discount_code: {
      anyOf: [
        { type: 'null' },
        {
          type: 'object',
          properties: {
            mode: { type: 'string', enum: ['percent', 'free_product'] },
            percent_off: { type: 'number' },
            product_query: { type: 'string' },
          },
          required: ['mode'],
          additionalProperties: false,
        },
      ],
      description: "REQUIRED when action_type is discount_code. From the advisor path this is always { mode: 'percent', percent_off: 10 } — higher percentages and free-product comps come from operator commands, never from the advisor. Otherwise null.",
    },
    items: {
      type: 'array',
      description: 'One entry per product being discussed/exchanged/refunded. Empty array when no items are in play.',
      items: {
        type: 'object',
        properties: {
          product: { type: 'string', description: 'product name' },
          current_size: { anyOf: [{ type: 'string' }, { type: 'null' }], description: 'size they have' },
          resolved_size: { anyOf: [{ type: 'string' }, { type: 'null' }], description: "size they're getting (null if unresolved)" },
          resolved_color: { anyOf: [{ type: 'string' }, { type: 'null' }], description: 'color they want (null if same color or not specified)' },
          resolved_product: { anyOf: [{ type: 'string' }, { type: 'null' }], description: 'different product if style switch (null if same)' },
          issue: { anyOf: [{ type: 'string' }, { type: 'null' }], description: 'close_fit_tight | close_fit_loose | doesnt_fit | way_off | defect | …' },
          state: { type: 'string', enum: ['CONFIRMED', 'AWAITING_DECISION', 'NEEDS_MEASUREMENT', 'REFUND_CONFIRMED', 'ROUTE_TO_HUMAN'] },
        },
        required: ['product', 'state'],
        additionalProperties: false,
      },
    },
    donation_needed: {
      type: 'boolean',
      description: 'True only when THIS message gives donation info (a just-created exchange, a just-processed refund, or a direct answer to where-do-I-send-it-back). False while you are still asking the customer for anything — the donation section belongs in the message that confirms the order, not the one that asks a question.',
    },
    customer_name: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    forwarded_sender_email: {
      anyOf: [{ type: 'string' }, { type: 'null' }],
      description: "ONLY set this when the conversation reached us as a customer email FORWARDED to us from an internal RUBIES staff address (e.g. the sender is @rubyshines.com and the body contains a forwarded-message header with an original 'From:'). Put the ORIGINAL external sender's email address here — the real customer, not the staff member who forwarded it. Null in every normal case where the customer emailed us directly.",
    },
    customer_pronouns: { type: 'string', enum: ['they/them', 'she/her', 'he/him'] },
    buying_for: { type: 'string', enum: ['self', 'third_party'] },
    third_party_label: { anyOf: [{ type: 'string' }, { type: 'null' }], description: 'daughter | son | child | null' },
    duties_refund_amount: { anyOf: [{ type: 'string' }, { type: 'null' }], description: "amount and currency if DDP duties refund (e.g. '13.90 EUR'), null otherwise" },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    summary: { type: 'string', description: "6-8 word lowercase summary for the queue list view (e.g. 'exchange AJ 14→16 too tight')" },
    history_summary: {
      anyOf: [{ type: 'string' }, { type: 'null' }],
      description: "2-4 sentence prose summary written for a future advisor call that needs this ticket as prior history: original order number and items, what the customer asked, action taken, outcome. Only for exchange/refund/defect tickets — null otherwise.",
    },
    customer_sentiment: {
      enum: ['positive', 'neutral', 'negative', null],
      description: "Overall customer tone across their messages. positive = gratitude/satisfaction. negative = frustration/complaint. neutral = matter-of-fact. null = no customer content to judge. Orthogonal to message_type — a refund ticket can still end positive.",
    },
    operator_action_summary: {
      anyOf: [{ type: 'string' }, { type: 'null' }],
      description: "Single-line natural-language description of the exact action the operator's tools must execute, matching the order changes the customer_reply promises. MUST be null when status is needs_info or gathering. Required when action_type is set OR the reply states (past tense) that an exchange/refund/edit/profile-update happened. INCLUDE products, quantities, sizes, colors, swaps, order numbers. EXCLUDE customer-facing instructions (donation addresses, washing instructions, ETAs, kind words). NEVER include dollar amounts — refunds are specified by order + items ('refund order #29812 for the 2x Brooke 2X'); the operator's tools compute amounts. Exchange example: 'exchange on order #29863: 2x AJ 10→8 Sandstone, 1x Ruby 10→8 Black'.",
    },
    routing_reason: {
      anyOf: [{ type: 'string' }, { type: 'null' }],
      description: "REQUIRED (non-null) whenever status is route_to_human: ONE plain sentence naming the specific reason this ticket needs Jamie, written for Jamie (e.g. 'Order stuck 4+ business days with no cause found — needs investigation', '3rd refund request on this account — review before refunding'). Name the rule or situation that triggered the routing, never a generic 'needs human review'. Null for every other status.",
    },
    flags: {
      type: 'array',
      items: { type: 'string' },
      description: "Operator-facing warning strings shown as a ⚠️ banner on the ticket — the customer never sees them and they never change your reply. Emit one when a rule tells you to raise a flag (e.g. the refund-pattern flag). Empty array when none.",
    },
    audit: { type: 'array', items: { type: 'string' }, description: 'Your reasoning steps, one per entry.' },
  },
  required: [
    'customer_reply', 'status', 'message_type', 'customer_intent', 'action_type',
    'action_order_number', 'new_address', 'customer_profile_update', 'discount_code', 'items',
    'donation_needed', 'customer_name', 'forwarded_sender_email', 'customer_pronouns', 'buying_for',
    'third_party_label', 'duties_refund_amount', 'confidence', 'summary',
    'history_summary', 'customer_sentiment', 'operator_action_summary', 'routing_reason', 'flags', 'audit',
  ],
  additionalProperties: false,
};

/**
 * Incremental extractor for streaming: feeds on raw JSON text deltas and emits
 * the unescaped contents of the customer_reply string as it generates, then
 * fires onProseComplete once the field's closing quote arrives.
 *
 * Handles: the key appearing across delta boundaries, escape sequences split
 * across deltas (\\n, \\", \\\\, \\uXXXX), and emits nothing outside the field.
 */
function createCustomerReplyStreamExtractor({ onReplyText, onProseComplete }) {
  const KEY = '"customer_reply"';
  let buffer = '';          // pre-field: accumulate until we find the key + opening quote
  let phase = 'seeking';    // seeking → inside → done
  let pendingEscape = '';   // partial escape sequence carried across deltas

  function unescapeChunk(chunk) {
    // Returns { text, consumed, pending } — pending holds an incomplete trailing escape.
    let out = '';
    let i = 0;
    while (i < chunk.length) {
      const c = chunk[i];
      if (c !== '\\') { out += c; i++; continue; }
      // escape sequence
      if (i + 1 >= chunk.length) return { text: out, pending: chunk.slice(i) };
      const e = chunk[i + 1];
      if (e === 'u') {
        if (i + 6 > chunk.length) return { text: out, pending: chunk.slice(i) };
        out += String.fromCharCode(parseInt(chunk.slice(i + 2, i + 6), 16));
        i += 6;
      } else {
        const map = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', '"': '"', '\\': '\\', '/': '/' };
        out += map[e] !== undefined ? map[e] : e;
        i += 2;
      }
    }
    return { text: out, pending: '' };
  }

  return function feed(delta) {
    if (phase === 'done' || !delta) return;

    if (phase === 'seeking') {
      buffer += delta;
      const keyIdx = buffer.indexOf(KEY);
      if (keyIdx === -1) {
        // keep only a tail long enough to catch a split key
        if (buffer.length > KEY.length * 2) buffer = buffer.slice(-KEY.length * 2);
        return;
      }
      const quoteIdx = buffer.indexOf('"', keyIdx + KEY.length + 1); // skip the colon region
      const colonIdx = buffer.indexOf(':', keyIdx + KEY.length);
      if (colonIdx === -1 || quoteIdx === -1 || quoteIdx < colonIdx) return; // opening quote not arrived yet
      phase = 'inside';
      delta = buffer.slice(quoteIdx + 1);
      buffer = '';
      // fall through to inside-handling with the remainder
    }

    // phase === 'inside'
    let chunk = pendingEscape + delta;
    pendingEscape = '';

    // find unescaped closing quote
    let closeIdx = -1;
    for (let i = 0; i < chunk.length; i++) {
      if (chunk[i] === '"') { closeIdx = i; break; }
      if (chunk[i] === '\\') i++; // skip escaped char (may run past end — fine)
    }

    if (closeIdx !== -1) {
      const { text } = unescapeChunk(chunk.slice(0, closeIdx));
      if (text) onReplyText(text);
      phase = 'done';
      onProseComplete();
      return;
    }

    const { text, pending } = unescapeChunk(chunk);
    pendingEscape = pending;
    if (text) onReplyText(text);
  };
}

// Short prompt note that replaces the old <structured> template block — field
// guidance now lives in the schema descriptions, which the model receives.
const STRUCTURED_OUTPUT_PROMPT_NOTE = `Your final message is automatically formatted as a JSON object (the system enforces the schema — you cannot deviate from it). Write the complete customer email in the customer_reply field exactly as you would have written it as the email body. Every other field follows its schema description. The customer_reply prose and the other fields are read together by the operator — they must never contradict each other (tense rules included: needs_info status means future-tense promises only).`;

// Legacy output instructions — the pre-schema <structured>-block convention.
// Used ONLY by the 529 fallback path: very large schema-enforced requests get
// load-shed by the API under capacity pressure (observed 2026-06-11: the same
// request passes without output_config and 529s with it, for 14h straight,
// while smaller schema requests pass). When that happens the advisor retries
// in legacy mode with this block swapped in for the note above.
const LEGACY_STRUCTURED_TEMPLATE = `After handling the conversation, you MUST end your final message with a structured JSON block wrapped in <structured> tags. This is required for every response.

<structured>
{
  "status": "ready|needs_info|gathering|route_to_human (use ready when ALL items are resolved OR when setting an explicit action_type below — the system automatically marks it action_needed for the operator. Use needs_info when waiting for customer input. Use gathering while still processing.)",
  "message_type": "exchange|refund|defect|sizing_inquiry|shipping|closing|general_inquiry|business_outreach|community_outreach|discount_request|uncategorized (IMPORTANT: always pick the single best-fit value from this exact list. If nothing fits, use 'uncategorized' — do not invent new values.)",
  "customer_intent": "exchange_same_product|exchange_different_product|refund|unsure|null",
  "action_type": "null|warehouse_hold|order_modification|cancellation|customer_profile_update|discount_code|split_shipment|invoice_kept_items",
  "action_order_number": "null OR the order number the staged action targets, digits only (e.g. '31485') — REQUIRED whenever action_type is set or operator_action_summary names an order. Usually the loaded order; when the operator or customer redirects the action to a DIFFERENT order, use THAT order's number (automatic actions like warehouse holds execute against it).",
  "new_address": "null OR { address1, city, province, zip, country } — REQUIRED when action_type is order_modification and the customer provided a new shipping address.",
  "customer_profile_update": "null OR { new_email, new_first_name, new_last_name } — REQUIRED when action_type is customer_profile_update.",
  "discount_code": "null OR { mode: 'percent'|'free_product', percent_off?: number, product_query?: string } — from the advisor path always { mode: 'percent', percent_off: 10 }.",
  "items": [{ "product": "...", "current_size": "...", "resolved_size": "... or null", "resolved_color": "... or null", "resolved_product": "... or null", "issue": "close_fit_tight|close_fit_loose|doesnt_fit|way_off|defect|...", "state": "CONFIRMED|AWAITING_DECISION|NEEDS_MEASUREMENT|REFUND_CONFIRMED|ROUTE_TO_HUMAN" }],
  "donation_needed": "true only when THIS message gives donation info (a just-created exchange, a just-processed refund, or a direct answer to where-do-I-send-it-back); false while you are still asking the customer for anything",
  "customer_name": "name or null",
  "customer_pronouns": "they/them|she/her|he/him",
  "buying_for": "self|third_party",
  "third_party_label": "daughter|son|child|null",
  "duties_refund_amount": "amount + currency or null",
  "confidence": "high|medium|low",
  "summary": "6-8 word lowercase queue summary",
  "history_summary": "2-4 sentence prose summary for future advisor calls (exchange/refund/defect only — null otherwise)",
  "customer_sentiment": "positive|neutral|negative|null",
  "operator_action_summary": "null OR single-line description of the exact operator action, matching the draft's promises. MUST be null when status is needs_info/gathering. Never include dollar amounts.",
  "routing_reason": "null OR one plain sentence naming the specific reason this ticket needs Jamie — REQUIRED (non-null) whenever status is route_to_human, null for every other status.",
  "flags": ["operator-facing warning strings (⚠️ banner; customer never sees them) — [] when none"],
  "audit": ["reasoning step 1", "reasoning step 2"]
}
</structured>

The text BEFORE the <structured> tags is the actual response to send to the customer. Write it as if you are emailing them directly.`;

/** Deep-strip description fields — experiment lever for schema-size effects
 * (grammar compilation cost scales with schema size; descriptions dominate
 * ours). Enable with ADVISOR_LEAN_SCHEMA=1. */
function stripDescriptions(node) {
  if (Array.isArray(node)) return node.map(stripDescriptions);
  if (node && typeof node === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(node)) {
      if (k === 'description') continue;
      out[k] = stripDescriptions(v);
    }
    return out;
  }
  return node;
}

const EFFECTIVE_SCHEMA = process.env.ADVISOR_LEAN_SCHEMA === '1'
  ? stripDescriptions(ADVISOR_OUTPUT_SCHEMA)
  : ADVISOR_OUTPUT_SCHEMA;

// Degraded-inference detector for the customer_reply field. Schema enforcement
// guarantees SHAPE, not content: under API load pressure the model can emit a
// structurally valid JSON whose free-text fields collapse to single punctuation
// tokens (observed 2026-06-12: customer_reply ",", items[].current_size ":").
// The shortest legitimate reply (post-action closing + signature) is far above
// 15 letters, so a letter-count floor separates the two cleanly.
function isDegenerateReply(text) {
  const letters = (String(text || '').match(/[a-zA-Z]/g) || []).length;
  return letters < 15;
}

// Load-shed circuit breaker for schema mode. A schema-call 529 means Anthropic
// is shedding large-grammar requests; during an incident window subsequent
// schema attempts don't fail fast — the server holds the streaming request
// (observed 47-150s) before erroring. So after any schema 529, start drafts
// directly in legacy mode for a cooldown, then probe schema again.
function createLoadShedBreaker(cooldownMs = 10 * 60 * 1000) {
  let lastTrippedAt = 0;
  return {
    trip(now = Date.now()) { lastTrippedAt = now; },
    active(now = Date.now()) { return lastTrippedAt > 0 && (now - lastTrippedAt) < cooldownMs; },
  };
}

module.exports = { ADVISOR_OUTPUT_SCHEMA: EFFECTIVE_SCHEMA, FULL_SCHEMA: ADVISOR_OUTPUT_SCHEMA, stripDescriptions, createCustomerReplyStreamExtractor, STRUCTURED_OUTPUT_PROMPT_NOTE, LEGACY_STRUCTURED_TEMPLATE, isDegenerateReply, createLoadShedBreaker };
