#!/usr/bin/env node

/**
 * One-time seed: upsert "How It Works" page into cs_knowledge_base.
 * Run: node customer-service/import/seed-how-it-works.js
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const { getSupabaseClient } = require('../../shared/supabaseClient');

const CONTENT = `# How No-Tuck Shaping Technology Works

## Main Concept

RUBIES specializes in designed undergarments and swimwear for trans girls and women. Rather than traditional tucking methods, the shaping technology converts anatomy into a more feminine mound through innovative design rather than extreme compression.

## Bottoms Guide

### Design Philosophy
The product intentionally avoids complete concealment. Instead, it converts the pointy area to a more feminine mound, making it significantly more comfortable than compression-based alternatives.

### How They Work
- Two layers of compression mesh work together
- Extra fabric on the outer surface provides reshaping capability
- An internal gusset panel adds structural strength (often mistaken for a tucking pocket)

### Wearing Instructions
RUBIES bottoms are worn like standard underwear — not too loose and not too tight — requiring no special tucking techniques.

## Tops Guide

### Target Design
Tops accommodate individuals with minimal natural bust development and feature pockets for optional padding experimentation.

### Key Features
- Adjustable straps and clasps designed for wider torsos
- Stretchy construction allows wearing with or without fastening clasps
- Sized appropriately for first-time wearers unfamiliar with traditional bra usage

## Philosophy Note

The brand emphasizes education: girls and women naturally vary in shape rather than being completely flat, visible in typical leggings-wearing imagery.`;

async function main() {
  const supabase = getSupabaseClient();

  const row = {
    id: 'page:how-it-works',
    title: 'How No-Tuck Shaping Technology Works',
    category: 'product',
    subcategory: 'technology',
    content: CONTENT,
    source: 'website',
    tags: ['how-it-works', 'shaping', 'no-tuck', 'technology', 'bottoms', 'tops'],
    priority: 5,
    updated_at: new Date().toISOString(),
  };

  const { error } = await supabase
    .from('cs_knowledge_base')
    .upsert(row, { onConflict: 'id' });

  if (error) {
    console.error('Failed to upsert:', error.message);
    process.exit(1);
  }

  console.log('Upserted "page:how-it-works" into cs_knowledge_base');

  // Generate embedding if embeddings module is available
  try {
    const { embedText } = require('../lib/embeddings');
    const embedding = await embedText(CONTENT);
    if (embedding) {
      const { error: embErr } = await supabase
        .from('cs_knowledge_base')
        .update({ embedding })
        .eq('id', 'page:how-it-works');

      if (embErr) console.error('Embedding update failed:', embErr.message);
      else console.log('Embedding generated and stored');
    }
  } catch (err) {
    console.log('Skipping embedding (embeddings module not available or VOYAGE_API_KEY not set)');
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
