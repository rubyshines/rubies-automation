/**
 * Parse-time smoke test for prompt-bearing modules.
 *
 * Multi-thousand-line system prompts live inside JS template literals. A stray
 * unescaped backtick (or any other syntax slip) terminates the literal and
 * throws SyntaxError at require time — but unit tests historically don't
 * import these modules (they stub them out), so a broken prompt edit can
 * pass the full suite and still take down production on the next deploy.
 *
 * This test imports each prompt-bearing module so any parse error surfaces
 * immediately. Add new entries when adding new prompt-bearing modules.
 *
 * Run: node --test customer-service/test/requireSmoke.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const PROMPT_MODULES = [
  '../lib/aiAdvisor',
  '../lib/operatorAgent',
  '../lib/operatorAgentStandalone',
  '../lib/thankYouClassifier',
];

describe('prompt-bearing modules parse cleanly', () => {
  for (const modPath of PROMPT_MODULES) {
    it(`require('${modPath}') succeeds`, () => {
      assert.doesNotThrow(
        () => require(modPath),
        `${modPath} threw at require time — likely a prompt template-literal syntax error`,
      );
    });
  }
});
