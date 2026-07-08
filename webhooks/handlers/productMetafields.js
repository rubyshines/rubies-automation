/**
 * Product metafield mapper — re-exports the single implementation from
 * customer-service/sync/syncProducts.js so the webhook and the daily sync
 * can never diverge on the metafields → products-table column mapping.
 */

const { mapMetafields } = require('../../customer-service/sync/syncProducts');

module.exports = { mapMetafields };
