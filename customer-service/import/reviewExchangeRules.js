#!/usr/bin/env node

/**
 * Review Exchange Decision Rules — Interactive CLI
 *
 * Lists extracted rules for Jamie to approve, edit, or reject.
 * Only approved rules (active=true) are used by the exchange_advisor tool.
 *
 * Usage:
 *   node customer-service/import/reviewExchangeRules.js              # review pending rules
 *   node customer-service/import/reviewExchangeRules.js --all        # review all rules including active
 *   node customer-service/import/reviewExchangeRules.js --summary    # just show counts
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../..', '.env') });

const readline = require('readline');
const { getSupabaseClient } = require('../../shared/supabaseClient');

const args = process.argv.slice(2);
const showAll = args.includes('--all');
const summaryOnly = args.includes('--summary');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createPrompt() {
  return readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
}

function ask(rl, question) {
  return new Promise(resolve => rl.question(question, resolve));
}

function formatRule(rule, index, total) {
  let md = '';
  md += `\n${'='.repeat(60)}\n`;
  md += `Rule ${index + 1}/${total}: ${rule.rule_key}\n`;
  md += `${'='.repeat(60)}\n`;
  md += `Category:  ${rule.category}\n`;
  md += `Priority:  ${rule.priority}\n`;
  md += `Status:    ${rule.active ? '✅ ACTIVE' : '⏳ PENDING'}\n`;
  md += `Source:    ${rule.source}\n`;
  md += `\n📋 WHEN:\n${rule.condition_description}\n`;
  md += `\n✅ DO:\n${rule.action_description}\n`;

  if (rule.anti_patterns?.length) {
    md += `\n❌ DON'T:\n`;
    for (const ap of rule.anti_patterns) {
      md += `  - ${ap}\n`;
    }
  }

  if (rule.examples?.length) {
    md += `\n📝 EXAMPLES:\n`;
    for (const ex of rule.examples) {
      md += `  - [${ex.conversation_id}] ${ex.summary}\n`;
    }
  }

  return md;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const supabase = getSupabaseClient();

  // Fetch rules
  let query = supabase
    .from('exchange_decision_rules')
    .select('*')
    .order('category', { ascending: true })
    .order('priority', { ascending: false });

  if (!showAll) {
    query = query.eq('active', false);
  }

  const { data: rules, error } = await query;
  if (error) throw new Error(`Failed to fetch rules: ${error.message}`);

  if (!rules || rules.length === 0) {
    console.log('No rules to review. Run extractExchangeRules.js first.');
    return;
  }

  // Summary
  const active = rules.filter(r => r.active).length;
  const pending = rules.filter(r => !r.active).length;
  const byCategory = {};
  for (const r of rules) {
    byCategory[r.category] = (byCategory[r.category] || 0) + 1;
  }

  console.log('\n📊 Exchange Decision Rules Summary');
  console.log(`Total: ${rules.length} | Active: ${active} | Pending: ${pending}`);
  console.log('By category:', byCategory);

  if (summaryOnly) return;

  // Interactive review
  const rl = createPrompt();
  console.log('\nCommands: [a]pprove, [r]eject (delete), [s]kip, [e]dit, [p]riority <n>, [q]uit\n');

  let approved = 0;
  let rejected = 0;
  let edited = 0;

  for (let i = 0; i < rules.length; i++) {
    const rule = rules[i];
    console.log(formatRule(rule, i, rules.length));

    const input = await ask(rl, '\n> Action: ');
    const cmd = input.trim().toLowerCase();

    if (cmd === 'q' || cmd === 'quit') {
      console.log('Quitting review.');
      break;
    }

    if (cmd === 'a' || cmd === 'approve') {
      const { error: updateErr } = await supabase
        .from('exchange_decision_rules')
        .update({ active: true, updated_at: new Date().toISOString() })
        .eq('id', rule.id);

      if (updateErr) {
        console.log(`  ❌ Error: ${updateErr.message}`);
      } else {
        console.log('  ✅ Approved');
        approved++;
      }
    } else if (cmd === 'r' || cmd === 'reject') {
      const { error: delErr } = await supabase
        .from('exchange_decision_rules')
        .delete()
        .eq('id', rule.id);

      if (delErr) {
        console.log(`  ❌ Error: ${delErr.message}`);
      } else {
        console.log('  🗑️  Deleted');
        rejected++;
      }
    } else if (cmd === 'e' || cmd === 'edit') {
      console.log('\nEditing (press Enter to keep current value):');

      const newCondition = await ask(rl, `  Condition [${rule.condition_description.slice(0, 50)}...]: `);
      const newAction = await ask(rl, `  Action [${rule.action_description.slice(0, 50)}...]: `);
      const newPriority = await ask(rl, `  Priority [${rule.priority}]: `);
      const newCategory = await ask(rl, `  Category [${rule.category}]: `);

      const updates = { updated_at: new Date().toISOString() };
      if (newCondition.trim()) updates.condition_description = newCondition.trim();
      if (newAction.trim()) updates.action_description = newAction.trim();
      if (newPriority.trim()) updates.priority = parseInt(newPriority.trim(), 10);
      if (newCategory.trim()) updates.category = newCategory.trim();

      const activateAfterEdit = await ask(rl, '  Activate now? [y/N]: ');
      if (activateAfterEdit.trim().toLowerCase() === 'y') {
        updates.active = true;
      }

      const { error: updateErr } = await supabase
        .from('exchange_decision_rules')
        .update(updates)
        .eq('id', rule.id);

      if (updateErr) {
        console.log(`  ❌ Error: ${updateErr.message}`);
      } else {
        console.log('  ✏️  Updated');
        edited++;
        if (updates.active) approved++;
      }
    } else if (cmd.startsWith('p') || cmd.startsWith('priority')) {
      const newPriority = parseInt(cmd.replace(/[^0-9]/g, ''), 10);
      if (isNaN(newPriority)) {
        console.log('  Invalid priority. Use: p 80');
        i--; // Re-show this rule
        continue;
      }

      const { error: updateErr } = await supabase
        .from('exchange_decision_rules')
        .update({ priority: newPriority, updated_at: new Date().toISOString() })
        .eq('id', rule.id);

      if (updateErr) {
        console.log(`  ❌ Error: ${updateErr.message}`);
      } else {
        console.log(`  📊 Priority set to ${newPriority}`);
      }
    } else {
      // Skip
      console.log('  ⏭️  Skipped');
    }
  }

  rl.close();

  console.log(`\n========================================`);
  console.log(`Review complete: ${approved} approved, ${rejected} rejected, ${edited} edited`);
  console.log(`========================================`);
}

main().catch(err => {
  console.error('[reviewExchangeRules] Fatal error:', err);
  process.exit(1);
});
