#!/usr/bin/env node
/**
 * Copy env vars from the main Railway service to all cron services.
 * Run once after creating new services.
 */
const fs = require('fs');
const https = require('https');
const os = require('os');
const path = require('path');

const config = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.railway/config.json'), 'utf8'));
const ACCESS_TOKEN = config.user.accessToken;
const PROJECT_ID = 'ac9b7c78-8b5d-406a-929f-833fec78cfa9';
const ENV_ID = 'd5c0cfea-28ce-4de6-a7fa-e5452d739489';
const MAIN_SVC = 'cccd4ba0-f219-41d6-85ff-bf7a41387ec1';

const CRON_SERVICES = [
  { id: '75c2d52d-c2b3-4eea-b3ac-18794117af81', name: 'daily-sales-report' },
  { id: 'bc4450d2-b964-4d30-842f-0744b1c7f5c4', name: 'daily-sync-all' },
  { id: 'e10fa9c2-36f9-469e-83f7-7471ed0f2fd9', name: 'daily-order-alerts' },
  { id: 'ada49dd4-35b4-415d-b0ef-cbf6ede2775b', name: 'daily-seo-tracking' },
  { id: 'e5a96c06-af66-416d-ae3b-7ee65633f994', name: 'passport-tracking-sync' },
  { id: '6cbd67b4-6d71-40d4-9d88-c622a6ba41f8', name: 'weekly-seo-digest' },
  { id: 'aabbda71-37bc-4e5d-b291-539bda155d6c', name: 'monthly-competitor-pricing' },
  { id: '2303e347-a55b-4f70-970d-298593e1f36b', name: 'daily-cs-comparison' },
  { id: 'b0d922fa-b672-4c26-850a-e2b970ccb69e', name: 'daily-cs-stats' },
  { id: '3ea556ed-3087-4ef5-82cb-d5ab538a97b8', name: 'cs-dashboard' },
  { id: '9b5beaad-be99-4964-ba31-6bbd9a07409f', name: 'cs-drift-check' },
];

function gql(query, variables) {
  const body = JSON.stringify({ query, variables });
  return new Promise((resolve, reject) => {
    const req = https.request('https://backboard.railway.com/graphql/v2', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + ACCESS_TOKEN, 'Content-Type': 'application/json' },
    }, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => resolve(JSON.parse(data)));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

(async () => {
  // Get vars from main service
  const varsResult = await gql(`query { variables(projectId: "${PROJECT_ID}", environmentId: "${ENV_ID}", serviceId: "${MAIN_SVC}") }`);
  const allVars = varsResult.data.variables;
  const skipPrefixes = ['RAILWAY_', 'NPM_CONFIG', 'NODE_ENV', 'NIXPACKS'];
  const vars = {};
  for (const [k, v] of Object.entries(allVars)) {
    if (!skipPrefixes.some(p => k.startsWith(p))) vars[k] = v;
  }
  console.log('Copying', Object.keys(vars).length, 'vars to each service...\n');

  for (const svc of CRON_SERVICES) {
    const result = await gql(
      `mutation($input: VariableCollectionUpsertInput!) { variableCollectionUpsert(input: $input) }`,
      { input: { projectId: PROJECT_ID, environmentId: ENV_ID, serviceId: svc.id, variables: vars } }
    );
    const ok = result.data?.variableCollectionUpsert;
    console.log(svc.name + ':', ok ? 'OK' : 'FAIL: ' + JSON.stringify(result.errors));
  }
})();
