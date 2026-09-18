#!/usr/bin/env node
'use strict';
/**
 * Run a SQL file against Supabase when SUPABASE_DATABASE_URL is set.
 *   node scripts/apply-sql.js virtual-closet/schema.sql
 * Without the URL, prints the file path to paste into the SQL editor.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');

async function main() {
  const file = process.argv[2];
  if (!file) { console.error('Usage: node scripts/apply-sql.js <file.sql>'); process.exit(1); }
  const sql = fs.readFileSync(path.resolve(file), 'utf8');
  const url = process.env.SUPABASE_DATABASE_URL;
  if (!url) {
    console.log(`SUPABASE_DATABASE_URL is not set. Paste this file into the Supabase SQL editor:\n  ${path.resolve(file)}`);
    process.exit(2);
  }
  const { Client } = require('pg');
  const client = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await client.connect();
  try {
    await client.query(sql);
    console.log(`Applied ${file}`);
  } finally { await client.end(); }
}

main().catch(err => { console.error(err.message); process.exit(1); });
