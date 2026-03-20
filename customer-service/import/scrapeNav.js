#!/usr/bin/env node
/**
 * Quick script to discover all pages/collections on rubyshines.com
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../..', '.env') });

async function main() {
  const resp = await fetch('https://rubyshines.com', {
    headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' }
  });
  const html = await resp.text();

  const re = /href="(\/(?:pages|collections|policies)[^"]*?)"/g;
  const links = new Set();
  let m;
  while ((m = re.exec(html)) !== null) {
    links.add(m[1].split('?')[0].split('#')[0]);
  }

  console.log('=== Pages/Collections/Policies found on homepage ===');
  [...links].sort().forEach(l => console.log(l));
}

main().catch(console.error);
