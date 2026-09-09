/**
 * Upsert a row into the customers mirror without forking on email changes.
 *
 * The customers table is keyed by email (PK), so a plain
 * `upsert(..., { onConflict: 'email' })` after a Shopify email change creates a
 * SECOND row sharing one shopify_customer_id and orphans the old one forever.
 * This helper resolves by shopify_customer_id first: when the same Shopify
 * customer already exists under a different email, the existing row is renamed
 * in place (preserving enriched columns the webhook payload doesn't carry —
 * totals, conversation counts) instead of forking. Safe under concurrency via
 * the partial unique index on customers(shopify_customer_id) — see
 * customers-unique-shopify-id.sql; a losing concurrent write errors and the
 * webhook retries rather than duplicating.
 */

async function upsertCustomerRow(supabase, row) {
  if (row.shopify_customer_id && row.email) {
    const { data: existing, error: selErr } = await supabase
      .from('customers')
      .select('email')
      .eq('shopify_customer_id', row.shopify_customer_id);
    if (selErr) throw new Error(`Customer lookup failed: ${selErr.message}`);

    let others = (existing || []).filter(r => r.email !== row.email);
    const target = (existing || []).find(r => r.email === row.email);

    if (others.length && !target) {
      // A row may already sit under the new email WITHOUT the shopify id: a
      // fork from before the id was recorded (the customer ordered under the
      // new address before Shopify told us it was the same person). Renaming
      // into it collides on the primary key, so that case is a merge: the
      // old rows' orders move to the surviving email and the old rows go.
      const { data: byEmail, error: emErr } = await supabase
        .from('customers').select('email').eq('email', row.email);
      if (emErr) throw new Error(`Customer lookup failed: ${emErr.message}`);
      if ((byEmail || []).length) {
        await moveOrders(supabase, others, row.email);
        await deleteOthers(supabase, row);
        others = [];
      } else {
        // Email changed in Shopify: rename the newest existing row in place
        // (orders follow via ON UPDATE CASCADE), then let the upsert below
        // refresh its fields.
        const keep = others.pop();
        const { error: updErr } = await supabase
          .from('customers')
          .update({ email: row.email })
          .eq('email', keep.email);
        if (updErr) throw new Error(`Customer email rename failed: ${updErr.message}`);
      }
    }
    if (others.length) {
      // Any remaining rows under old emails are forks from before this fix —
      // the row under the current email is authoritative, drop the orphans.
      // Their orders come along first: the foreign key cascades on update,
      // not on delete.
      await moveOrders(supabase, others, row.email);
      await deleteOthers(supabase, row);
    }
  }

  const { error } = await supabase
    .from('customers')
    .upsert(row, { onConflict: 'email' });
  if (error) throw new Error(`Customer upsert failed: ${error.message}`);
}

/** Re-point the orders of each old row at the surviving email. */
async function moveOrders(supabase, rows, email) {
  for (const r of rows) {
    const { error } = await supabase.from('orders').update({ customer_email: email }).eq('customer_email', r.email);
    if (error) throw new Error(`Customer order move failed: ${error.message}`);
  }
}

/** Drop every row sharing the shopify id except the one under the current email. */
async function deleteOthers(supabase, row) {
  const { error } = await supabase
    .from('customers')
    .delete()
    .eq('shopify_customer_id', row.shopify_customer_id)
    .neq('email', row.email);
  if (error) throw new Error(`Customer orphan cleanup failed: ${error.message}`);
}

module.exports = { upsertCustomerRow };
