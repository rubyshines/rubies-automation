#!/usr/bin/env node

/**
 * Register/list/delete Shopify webhook subscriptions
 *
 * Usage:
 *   node webhooks/scripts/registerShopifyWebhooks.js                  # register all
 *   node webhooks/scripts/registerShopifyWebhooks.js --list           # list current
 *   node webhooks/scripts/registerShopifyWebhooks.js --delete         # delete all
 *   node webhooks/scripts/registerShopifyWebhooks.js --dev            # use localtunnel URL
 *
 * Requires WEBHOOK_BASE_URL env var (e.g. https://rubies-webhooks.up.railway.app)
 * or --dev flag with DEV_TUNNEL_URL env var.
 */

const path = require('path');
if (!process.env.SUPABASE_URL) {
  require('dotenv').config({ path: path.resolve(__dirname, '../..', '.env') });
}

const SHOPIFY_API_VERSION = '2025-10';

function getConfig() {
  const storeUrl = process.env.SHOPIFY_STORE_URL;
  const token = process.env.SHOPIFY_ACCESS_TOKEN || process.env.SHOPIFY_PASSWORD || process.env.SHOPIFY_API_PASSWORD;
  if (!storeUrl || !token) throw new Error('Missing SHOPIFY_STORE_URL and SHOPIFY_ACCESS_TOKEN');
  return { storeUrl, token };
}

async function shopifyGraphQL(query, variables = {}) {
  const { storeUrl, token } = getConfig();
  const url = `https://${storeUrl}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
    body: JSON.stringify({ query, variables }),
  });
  if (!response.ok) throw new Error(`Shopify API error: ${response.status} ${await response.text()}`);
  const json = await response.json();
  if (json.errors) throw new Error(`GraphQL errors: ${JSON.stringify(json.errors)}`);
  return json.data;
}

// Webhook topics and their corresponding URL path segments
const WEBHOOK_TOPICS = [
  { topic: 'ORDERS_CREATE', path: 'orders-create' },
  { topic: 'ORDERS_UPDATED', path: 'orders-updated' },
  { topic: 'CUSTOMERS_UPDATE', path: 'customers-update' },
  { topic: 'INVENTORY_LEVELS_UPDATE', path: 'inventory-levels-update' },
  { topic: 'FULFILLMENTS_CREATE', path: 'fulfillments-create' },
  { topic: 'FULFILLMENTS_UPDATE', path: 'fulfillments-update' },
  { topic: 'PRODUCTS_CREATE', path: 'products-create' },
  { topic: 'PRODUCTS_UPDATE', path: 'products-update' },
];

async function listWebhooks() {
  const data = await shopifyGraphQL(`
    query {
      webhookSubscriptions(first: 50) {
        edges {
          node {
            id
            topic
            callbackUrl
            format
            createdAt
          }
        }
      }
    }
  `);
  const hooks = data.webhookSubscriptions.edges.map(e => e.node);
  if (!hooks.length) {
    console.log('No webhook subscriptions found.');
    return hooks;
  }
  console.log(`Found ${hooks.length} webhook subscription(s):\n`);
  for (const h of hooks) {
    console.log(`  ${h.topic}`);
    console.log(`    URL: ${h.callbackUrl}`);
    console.log(`    ID:  ${h.id}`);
    console.log(`    Created: ${h.createdAt}\n`);
  }
  return hooks;
}

async function registerWebhooks(baseUrl) {
  console.log(`Registering webhooks with base URL: ${baseUrl}\n`);

  for (const { topic, path: urlPath } of WEBHOOK_TOPICS) {
    const callbackUrl = `${baseUrl}/webhooks/shopify/${urlPath}`;
    try {
      const data = await shopifyGraphQL(`
        mutation webhookCreate($topic: WebhookSubscriptionTopic!, $webhookSubscription: WebhookSubscriptionInput!) {
          webhookSubscriptionCreate(topic: $topic, webhookSubscription: $webhookSubscription) {
            webhookSubscription {
              id
              topic
              callbackUrl
            }
            userErrors {
              field
              message
            }
          }
        }
      `, {
        topic,
        webhookSubscription: {
          callbackUrl,
          format: 'JSON',
        },
      });

      const result = data.webhookSubscriptionCreate;
      if (result.userErrors?.length) {
        console.error(`  ${topic}: FAILED — ${result.userErrors.map(e => e.message).join(', ')}`);
      } else {
        console.log(`  ${topic}: registered → ${callbackUrl}`);
      }
    } catch (err) {
      console.error(`  ${topic}: ERROR — ${err.message}`);
    }
  }
}

async function deleteAllWebhooks() {
  const hooks = await listWebhooks();
  if (!hooks.length) return;

  console.log(`\nDeleting ${hooks.length} webhook(s)...\n`);
  for (const h of hooks) {
    try {
      await shopifyGraphQL(`
        mutation webhookDelete($id: ID!) {
          webhookSubscriptionDelete(id: $id) {
            deletedWebhookSubscriptionId
            userErrors { field message }
          }
        }
      `, { id: h.id });
      console.log(`  Deleted: ${h.topic}`);
    } catch (err) {
      console.error(`  Failed to delete ${h.topic}: ${err.message}`);
    }
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

(async () => {
  const args = process.argv.slice(2);
  const isDev = args.includes('--dev');
  const isList = args.includes('--list');
  const isDelete = args.includes('--delete');

  if (isList) {
    await listWebhooks();
    return;
  }

  if (isDelete) {
    await deleteAllWebhooks();
    return;
  }

  const baseUrl = isDev
    ? (process.env.DEV_TUNNEL_URL || 'http://localhost:3000')
    : process.env.WEBHOOK_BASE_URL;

  if (!baseUrl) {
    console.error('Set WEBHOOK_BASE_URL env var (or use --dev with DEV_TUNNEL_URL)');
    process.exit(1);
  }

  await registerWebhooks(baseUrl.replace(/\/$/, ''));
  console.log('\nDone! Run with --list to verify.');
})().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
