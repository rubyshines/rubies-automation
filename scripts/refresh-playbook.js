// Rebuild the marketing playbook (deterministic stats + one Opus synthesis pass).
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { refreshPlaybook } = require('../customer-service/lib/playbook');
refreshPlaybook()
  .then((r) => { console.log(`Playbook built: ${r.campaigns_analyzed} campaigns through ${r.through_date}\n\n${r.narrative}`); })
  .catch((e) => { console.error(e.message); process.exit(1); });
