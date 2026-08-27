/**
 * QuickBooks Online API Client — singleton pattern
 *
 * Uses Node built-in fetch. Auto-refreshes OAuth tokens via oauthManager.
 * Retry on 401 (token expired), 429 (rate limit), and 5xx errors.
 *
 * Usage:
 *   const { getQboClient } = require('./qbo');
 *   const qbo = getQboClient();
 *   const pl = await qbo.getProfitAndLoss('2025-01-01', '2025-12-31');
 */

const { getAccessToken } = require('./oauthManager');

const BASE_URL = 'https://quickbooks.api.intuit.com/v3/company';
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 1000;

let client = null;

function getQboClient() {
  if (client) return client;

  // ── Core fetch with auth + retry ────────────────────────────────────

  async function qboFetch(endpoint, { method = 'GET', params = {}, body = null, retries = MAX_RETRIES } = {}) {
    let lastError;

    for (let attempt = 0; attempt <= retries; attempt++) {
      const { accessToken, realmId } = await getAccessToken();
      const url = new URL(`${BASE_URL}/${realmId}/${endpoint}`);

      for (const [key, val] of Object.entries(params)) {
        if (val != null) url.searchParams.set(key, String(val));
      }

      const options = {
        method,
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
      };

      if (body) options.body = JSON.stringify(body);

      try {
        const res = await fetch(url.toString(), options);

        if (res.ok) {
          return await res.json();
        }

        const status = res.status;
        const resBody = await res.text();

        // 401 — token may have expired between our check and the API call
        if (status === 401 && attempt < retries) {
          console.error(`[QBO] 401 on attempt ${attempt + 1}, forcing token refresh...`);
          // oauthManager will refresh on next getAccessToken() call since we didn't cache
          await sleep(RETRY_BASE_MS);
          continue;
        }

        // 429 — rate limited
        if (status === 429 && attempt < retries) {
          const retryAfter = parseInt(res.headers.get('Retry-After') || '5', 10);
          console.error(`[QBO] Rate limited, waiting ${retryAfter}s...`);
          await sleep(retryAfter * 1000);
          continue;
        }

        // 5xx — server error, retry with backoff
        if (status >= 500 && attempt < retries) {
          const delay = RETRY_BASE_MS * Math.pow(2, attempt);
          console.error(`[QBO] ${status} on attempt ${attempt + 1}, retrying in ${delay}ms...`);
          await sleep(delay);
          continue;
        }

        lastError = new Error(`QBO API ${status}: ${resBody.slice(0, 500)}`);
      } catch (err) {
        if (attempt < retries) {
          const delay = RETRY_BASE_MS * Math.pow(2, attempt);
          console.error(`[QBO] Network error on attempt ${attempt + 1}: ${err.message}, retrying in ${delay}ms...`);
          await sleep(delay);
          lastError = err;
          continue;
        }
        lastError = err;
      }
    }

    throw lastError;
  }

  // ── Reports API ─────────────────────────────────────────────────────

  async function getReport(reportType, params = {}) {
    return qboFetch(`reports/${reportType}`, { params });
  }

  async function getProfitAndLoss(startDate, endDate, { accountingMethod = 'Accrual', summarizeBy } = {}) {
    const params = {
      start_date: startDate,
      end_date: endDate,
      accounting_method: accountingMethod,
    };
    if (summarizeBy) params.summarize_column_by = summarizeBy;
    return getReport('ProfitAndLoss', params);
  }

  // QBO silently ignores end_date on BalanceSheet unless start_date is also
  // present, and falls back to its default period (this fiscal year to date).
  // Every "as of <historical date>" call therefore returned TODAY's balances —
  // which is how 354 stored snapshots all ended up holding the same figures.
  // The epoch just has to predate the company; balances are cumulative to end_date.
  const BALANCE_SHEET_EPOCH = '2000-01-01';

  async function getBalanceSheet(asOfDate, { accountingMethod = 'Accrual' } = {}) {
    return getReport('BalanceSheet', {
      start_date: BALANCE_SHEET_EPOCH,
      end_date: asOfDate,
      accounting_method: accountingMethod,
    });
  }

  async function getCashFlowStatement(startDate, endDate) {
    return getReport('CashFlow', {
      start_date: startDate,
      end_date: endDate,
    });
  }

  async function getTrialBalance(asOfDate) {
    return getReport('TrialBalance', { end_date: asOfDate });
  }

  async function getARAgingSummary(asOfDate) {
    return getReport('AgedReceivables', { end_date: asOfDate });
  }

  async function getAPAgingSummary(asOfDate) {
    return getReport('AgedPayables', { end_date: asOfDate });
  }

  async function getBudgetSummary(startDate, endDate) {
    return getReport('BudgetSummary', {
      start_date: startDate,
      end_date: endDate,
    });
  }

  async function getGeneralLedger(startDate, endDate) {
    return getReport('GeneralLedger', {
      start_date: startDate,
      end_date: endDate,
    });
  }

  // ── Query API ───────────────────────────────────────────────────────

  async function query(entityType, whereClause = '', { maxResults = 1000, startPosition = 1 } = {}) {
    let sql = `SELECT * FROM ${entityType}`;
    if (whereClause) sql += ` WHERE ${whereClause}`;
    sql += ` MAXRESULTS ${maxResults} STARTPOSITION ${startPosition}`;

    const data = await qboFetch('query', { params: { query: sql } });
    return data.QueryResponse?.[entityType] || [];
  }

  async function queryAll(entityType, whereClause = '') {
    const results = [];
    let startPosition = 1;
    const pageSize = 1000;

    while (true) {
      const page = await query(entityType, whereClause, {
        maxResults: pageSize,
        startPosition,
      });
      results.push(...page);
      if (page.length < pageSize) break;
      startPosition += pageSize;
    }

    return results;
  }

  // Typed transaction queries (for sync)
  async function getAccounts() {
    return queryAll('Account');
  }

  async function getTransactionsSince(entityType, sinceDate) {
    const where = sinceDate
      ? `MetaData.LastUpdatedTime > '${sinceDate}'`
      : '';
    return queryAll(entityType, where);
  }

  // ── Convenience: fetch all transaction types since a date ───────────

  const TRANSACTION_TYPES = [
    'Invoice', 'Bill', 'Payment', 'Deposit', 'Purchase',
    'JournalEntry', 'Transfer', 'CreditMemo', 'VendorCredit', 'SalesReceipt',
  ];

  async function getAllTransactionsSince(sinceDate) {
    const all = [];
    for (const type of TRANSACTION_TYPES) {
      try {
        const txns = await getTransactionsSince(type, sinceDate);
        for (const txn of txns) {
          all.push({ ...txn, _txnType: type });
        }
        if (txns.length) {
          console.error(`[QBO] Fetched ${txns.length} ${type}(s)`);
        }
      } catch (err) {
        // Some entity types may not exist for this company — skip gracefully
        if (err.message?.includes('400') || err.message?.includes('not supported')) {
          console.error(`[QBO] Skipping ${type}: ${err.message.slice(0, 100)}`);
        } else {
          throw err;
        }
      }
    }
    return all;
  }

  // ── Test mode ───────────────────────────────────────────────────────

  async function testConnection() {
    const accounts = await getAccounts();
    console.log(`QBO connection OK — ${accounts.length} accounts found`);
    const byType = {};
    for (const a of accounts) {
      byType[a.AccountType] = (byType[a.AccountType] || 0) + 1;
    }
    console.log('Account types:', JSON.stringify(byType, null, 2));
    return accounts;
  }

  // ── Build client ────────────────────────────────────────────────────

  client = {
    qboFetch,
    getReport,
    getProfitAndLoss,
    getBalanceSheet,
    getCashFlowStatement,
    getTrialBalance,
    getARAgingSummary,
    getAPAgingSummary,
    getBudgetSummary,
    getGeneralLedger,
    query,
    queryAll,
    getAccounts,
    getTransactionsSince,
    getAllTransactionsSince,
    testConnection,
    TRANSACTION_TYPES,
  };

  return client;
}

// ── Helpers ─────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = { getQboClient };

// ── Standalone test ─────────────────────────────────────────────────────

if (require.main === module) {
  const path = require('path');
  if (!process.env.SUPABASE_URL) {
    require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
  }

  getQboClient().testConnection()
    .then(() => process.exit(0))
    .catch(err => {
      console.error('QBO test failed:', err.message);
      process.exit(1);
    });
}
