/**
 * Operator agent conversation history — the agent's own reply must survive into
 * the next turn.
 *
 * Live defect on ticket 3320 / draft 3571 (2026-08-25). runToolLoop breaks out of
 * its loop on the round that carries no tool_use, so it never appends that round's
 * assistant message and the `messages` it returns stop at the last tool_result.
 * operatorAgent returned those verbatim as `history`, the dashboard persisted them
 * to `cs_ai_drafts.action_result.chat_history`, and the next turn replayed a
 * conversation in which the agent had never spoken — i.e. the phase 1 preview was
 * gone. A following "confirm" then had only a tool_result to work from, and the
 * model re-narrated the preview instead of calling phase 2. Because its
 * re-narration was dropped the same way, confirming again hit the identical state:
 * an operator could confirm repeatedly and never see the action execute.
 *
 * The visible signature in stored history is two consecutive `user` messages with
 * no assistant turn between them, which is also an invalid shape to replay.
 *
 * Pure: aiClient and the tool catalog are stubbed, no network.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const LIB = path.join(__dirname, '..', 'lib');
const SHARED = path.join(__dirname, '..', '..', 'shared');
const stub = (id, exports) => { require.cache[require.resolve(id)] = { id, filename: id, loaded: true, exports }; };

// Scripted API rounds, consumed in order. Each entry is one Anthropic response.
const state = { rounds: [], seenMessages: [] };

const { withToolCaching } = require(path.join(SHARED, 'aiClient.js'));

stub(path.join(SHARED, 'aiClient.js'), {
  withToolCaching,
  callClaude: async (params) => {
    state.seenMessages.push(params.messages);
    const next = state.rounds.shift();
    if (!next) throw new Error('callClaude called more times than the test scripted');
    return { content: next, usage: {}, _ai_call_id: 'call-1' };
  },
});

stub(path.join(LIB, 'operatorTools.js'), {
  loadAllOperatorTools: () => ({
    tools: [
      { name: 'get_order_details', description: 'read', input_schema: { type: 'object' } },
      { name: 'edit_order', description: 'write', input_schema: { type: 'object' } },
    ],
    handlers: {
      get_order_details: async () => ({ content: [{ type: 'text', text: 'order data' }] }),
      edit_order: async (input) => ({
        content: [{
          type: 'text',
          text: input.confirmed
            ? '**Order Edit Completed** — swapped Black 1X for Black L.'
            : '**Order Edit Staged — awaiting confirmation.** Pass confirmed: true to commit.',
        }],
      }),
    },
  }),
});

const { operatorAgent } = require(path.join(LIB, 'operatorAgent.js'));

const text = (t) => ({ type: 'text', text: t });
const toolUse = (name, input = {}) => ({ type: 'tool_use', id: `tu-${name}`, name, input });

const ctx = () => ({
  customer_email: 'buyer@example.com',
  order_number: '32993',
  order_items: [],
  fulfillment_status: 'UNFULFILLED',
  intake: null,
  draft: { draft_response: 'Hi there', actions: [] },
  completed_actions: [],
});

const roles = (history) => history.map(m => m.role);

test('the phase 1 preview survives into the returned history', async () => {
  state.rounds = [
    [text('Staging the swap…'), toolUse('edit_order', { order_number: '32993' })],
    [text('**Order Edit Staged — awaiting confirmation.**\nSwap Black 1X → Black L.\nAUTO_CONFIRM: HOLD — target size is out of stock')],
  ];
  state.seenMessages = [];

  const result = await operatorAgent('swap the black 1X to L', ctx(), []);

  assert.ok(
    result.history.length > 0 && result.history[result.history.length - 1].role === 'assistant',
    'history must end with the agent\'s own reply, not a tool_result',
  );
  assert.match(result.history[result.history.length - 1].content, /awaiting confirmation/i);
});

test('history never contains two consecutive user messages across turns', async () => {
  // Deliberately a TWO-turn test. The broken shape cannot appear within a single
  // turn — it only shows up where the next operator command lands straight after a
  // tool_result — so a one-turn version of this test passes on the bug and proves
  // nothing.
  state.rounds = [
    [text('Looking up the order…'), toolUse('get_order_details')],
    [text('Staging…'), toolUse('edit_order', { order_number: '32993' })],
    [text('**Order Edit Staged — awaiting confirmation.**')],
  ];
  state.seenMessages = [];
  const turn1 = await operatorAgent('swap it', ctx(), []);

  state.rounds = [
    [text('Committing…'), toolUse('edit_order', { order_number: '32993', confirmed: true })],
    [text('**Order Edit Completed**')],
  ];
  state.seenMessages = [];
  const turn2 = await operatorAgent('confirm', ctx(), turn1.history);

  const r = roles(turn2.history);
  for (let i = 1; i < r.length; i++) {
    assert.ok(
      !(r[i] === 'user' && r[i - 1] === 'user'),
      `two consecutive user messages at ${i}: ${r.join(' → ')}`,
    );
  }
});

test('the AUTO_CONFIRM verdict is stripped from persisted history', async () => {
  state.rounds = [
    [text('Staging…'), toolUse('edit_order', { order_number: '32993' })],
    [text('**Order Edit Staged — awaiting confirmation.**\nAUTO_CONFIRM: HOLD — out of stock')],
  ];
  state.seenMessages = [];

  const result = await operatorAgent('swap it', ctx(), []);
  const persisted = JSON.stringify(result.history);
  // Feeding the model its own verdict lines teaches it to emit them on phase 2
  // summaries, where the prompt says they must never appear.
  assert.doesNotMatch(persisted, /AUTO_CONFIRM/,
    'the automation-only verdict must not be replayed back to the model');
  assert.deepStrictEqual(result.auto_confirm, { safe: false, reason: 'out of stock' });
});

test('turn 2 replays the preview, so a bare "confirm" has something to confirm', async () => {
  state.rounds = [
    [text('Staging…'), toolUse('edit_order', { order_number: '32993' })],
    [text('**Order Edit Staged — awaiting confirmation.** Swap Black 1X → Black L.')],
  ];
  state.seenMessages = [];
  const turn1 = await operatorAgent('swap the black 1X to L', ctx(), []);

  state.rounds = [
    [text('Committing…'), toolUse('edit_order', { order_number: '32993', confirmed: true })],
    [text('**Order Edit Completed**')],
  ];
  state.seenMessages = [];
  await operatorAgent('confirm', ctx(), turn1.history);

  // What the model actually received on the confirm turn.
  const sent = JSON.stringify(state.seenMessages[0]);
  assert.match(sent, /awaiting confirmation/i,
    'the confirm turn must be able to see the preview the agent gave');

  // And the operator's "confirm" must not land directly on a tool_result.
  const replayed = state.seenMessages[0];
  const confirmIdx = replayed.findIndex(m => m.role === 'user' && m.content === 'confirm');
  assert.ok(confirmIdx > 0, 'the confirm message is present');
  assert.strictEqual(replayed[confirmIdx - 1].role, 'assistant',
    'the message before the confirm must be the agent\'s preview');
});

test('an empty final reply appends nothing rather than an invalid empty message', async () => {
  // The API rejects a message with empty content, so a turn that produced no text
  // must leave history alone instead of appending a blank assistant turn.
  state.rounds = [
    [toolUse('edit_order', { order_number: '32993' })],
    [],
  ];
  state.seenMessages = [];

  const result = await operatorAgent('swap it', ctx(), []);
  for (const m of result.history) {
    const empty = typeof m.content === 'string' ? !m.content.trim() : m.content.length === 0;
    assert.ok(!empty, 'no message in history may have empty content');
  }
});
