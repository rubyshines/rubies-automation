/**
 * MCP tools: list_suppliers, manage_supplier
 * Read and upsert the vendor registry (manufacturers, studio, freight forwarders, QC inspectors).
 */

const { listSuppliers, upsertSupplier } = require('../merchandising/supplierRegistry');

async function handleListSuppliers({ type } = {}) {
  let rows = await listSuppliers();
  if (type) rows = rows.filter(r => r.type === type);
  if (!rows.length) return { content: [{ type: 'text', text: 'No suppliers found.' }] };
  const lines = [`## Vendors (${rows.length})`, '', '| Name | Type | Company | Contact | SWIFT | Terms |', '|---|---|---|---|---|---|'];
  for (const s of rows) {
    const terms = s.payment_terms ? JSON.stringify(s.payment_terms) : '-';
    lines.push(`| ${s.name} | ${s.type || '-'} | ${s.company_name || ''} | ${s.contact_name || ''} | ${s.swift || '-'} | ${terms} |`);
  }
  return { content: [{ type: 'text', text: lines.join('\n') }] };
}

// Columns a caller may set via manage_supplier.
const ALLOWED = new Set([
  'name', 'type', 'company_name', 'contact_name', 'email', 'sku_prefixes', 'notes',
  'address_line1', 'address_line2', 'city', 'region', 'postal_code', 'country',
  'phone', 'whatsapp', 'website', 'lead_time_days', 'incoterms', 'payment_terms',
  'contacts', 'bank_name', 'bank_address', 'swift', 'account_number', 'beneficiary_name',
]);

async function handleManageSupplier(params) {
  if (!params || !params.name) return { content: [{ type: 'text', text: 'Error: `name` is required.' }] };
  const patch = {};
  for (const [k, v] of Object.entries(params)) {
    if (ALLOWED.has(k) && v !== undefined) patch[k] = v;
  }
  const { row, created } = await upsertSupplier(patch);
  const verb = created ? 'Created' : 'Updated';
  return { content: [{ type: 'text', text: `## ${verb} vendor — ${row.name}\nType: ${row.type} · Company: ${row.company_name || '-'} · Contact: ${row.contact_name || '-'}${row.swift ? ` · SWIFT: ${row.swift}` : ''}` }] };
}

module.exports = [
  {
    name: 'list_suppliers',
    description: 'List vendors in the registry (manufacturers, studio, freight forwarders, QC inspectors). Optionally filter by type.',
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string', description: 'Optional filter: manufacturer | studio | freight_forwarder | qc_inspector' },
      },
    },
    handler: handleListSuppliers,
  },
  {
    name: 'manage_supplier',
    description: 'Create or update a vendor (upsert by name). Pass name plus any fields to set: type, company_name, contact_name, email, phone, whatsapp, website, address_line1/2, city, region, postal_code, country, lead_time_days, incoterms, payment_terms (JSON), contacts (JSON), bank_name, bank_address, swift, account_number, beneficiary_name, sku_prefixes (array), notes.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Vendor name (match key for upsert)' },
        type: { type: 'string', description: 'manufacturer | studio | freight_forwarder | qc_inspector' },
        company_name: { type: 'string' },
        contact_name: { type: 'string' },
        email: { type: 'string' },
        phone: { type: 'string' },
        whatsapp: { type: 'string' },
        website: { type: 'string' },
        address_line1: { type: 'string' },
        address_line2: { type: 'string' },
        city: { type: 'string' },
        region: { type: 'string' },
        postal_code: { type: 'string' },
        country: { type: 'string' },
        lead_time_days: { type: 'number' },
        incoterms: { type: 'string' },
        payment_terms: { description: 'Installment schedule, e.g. [{"type":"deposit","pct":30,"due":"placement"}]' },
        contacts: { description: 'Array of contacts [{name,email,phone,role}]' },
        bank_name: { type: 'string' },
        bank_address: { type: 'string' },
        swift: { type: 'string' },
        account_number: { type: 'string' },
        beneficiary_name: { type: 'string' },
        sku_prefixes: { type: 'array', items: { type: 'string' } },
        notes: { type: 'string' },
      },
      required: ['name'],
    },
    handler: handleManageSupplier,
  },
];
