-- Merchandising vendor enrichment seed — RUN AFTER merchandising_v2.sql.
--
-- Populates the new suppliers columns from the overnight enrichment review
-- (temp-analysis-data/supplier-enrichment.md + supplier-emails-deep.md). HIGH-confidence
-- fields are filled; UNCERTAIN/MISSING fields are left NULL and called out in `notes` so the
-- founder can close them in one later pass (esp. bank details that live in PI attachments).
-- Idempotent: UPDATEs by name; INSERTs guarded by NOT EXISTS.

-- ---------------------------------------------------------------------------
-- Kali — JINJIANG JIHE IMPORT AND EXPORT TRADE CO., LTD (manufacturer, catch-all factory)
-- BANK FLAGGED: 2026 PI = ICBC Fujian (seeded as current); 2025 PI = JPMorgan Chase HK. Confirm.
-- ---------------------------------------------------------------------------
UPDATE suppliers SET
  type = 'manufacturer',
  company_name = 'JINJIANG JIHE IMPORT AND EXPORT TRADE CO., LTD',
  contact_name = 'Kali Lin',
  address_line1 = 'No. 58 Yingshuang West, Yushan Village, Jinjing Town',
  city = 'Jinjiang City', region = 'Fujian Province', country = 'China',
  phone = '86-13599172227',
  incoterms = 'EXW Jinjiang (sea, Jinjiang China -> Canada; freight via Harry/CLH)',
  payment_terms = '[{"type":"deposit","pct":30,"due":"placement"},{"type":"balance","pct":70,"due":"ship"}]'::jsonb,
  bank_name = 'Industrial and Commercial Bank of China, Fujian Branch',
  bank_address = 'No.108 Gutian Rd, Fuzhou, Fujian, China',
  swift = 'ICBKCNBJFJN',
  account_number = '1408012519601096438',
  beneficiary_name = 'JINJIANG JIHE IMPORT AND EXPORT TRADE CO., LTD',
  notes = 'Catch-all factory. BANK UNCONFIRMED: seeded 2026 ICBC Fujian; 2025 PI used JPMorgan Chase HK (SWIFT CHASHKHH, acct 63003676921) — confirm current before T/T. Website unknown.'
WHERE name = 'Kali';

-- ---------------------------------------------------------------------------
-- Queenas — SHANTOU QUEENA GARMENT & ACCESSORY INDUSTRY LIMITED (manufacturer, SB/AVA bra)
-- ---------------------------------------------------------------------------
UPDATE suppliers SET
  type = 'manufacturer',
  company_name = 'SHANTOU QUEENA GARMENT & ACCESSORY INDUSTRY LIMITED',
  contact_name = 'Fandy Xie',
  address_line1 = 'Huayin Bldg., No.112 Songshanbei Road, Longhu Zone',
  city = 'Shantou', region = 'Guangdong', postal_code = '515041', country = 'China',
  phone = '86-754-88381098',
  website = 'queenas.com',
  notes = 'Fax 86-754-88381068. MISSING: bank/beneficiary, payment terms, incoterms, lead time — no PI in synced email; locate a Queenas PI.'
WHERE name = 'Queenas';

-- ---------------------------------------------------------------------------
-- JustMax — SHAOXING JUSTMAX APPAREL CO., LTD. (manufacturer, SWS surf shorts)
-- Legal entity from Wise receipt; bank + exact % in Gmail attachment PI JMP260528-01.xls.
-- ---------------------------------------------------------------------------
UPDATE suppliers SET
  type = 'manufacturer',
  company_name = 'SHAOXING JUSTMAX APPAREL CO., LTD.',
  contact_name = 'Maggie Chen',
  address_line1 = 'Rm.601, Block 1, KUNLUN International, No.395 Shengli East Road',
  city = 'Shaoxing', region = 'Zhejiang', postal_code = '312000', country = 'China',
  phone = '+86 13806741254', whatsapp = '+86 13806741254',
  website = 'justmax.cn',
  lead_time_days = 60,
  payment_terms = '[{"type":"deposit","due":"placement"},{"type":"balance","due":"delivery"}]'::jsonb,
  notes = 'Deposit-then-balance (exact % TBD). +$1/unit for swim lining. MISSING bank/beneficiary + exact terms — in Gmail attachment PI JMP260528-01.xls (2026-05-28 "Re: production order"); pull to complete.'
WHERE name = 'JustMax';

-- ---------------------------------------------------------------------------
-- Wumes — gel pads / MPAD (manufacturer). Zero email footprint; founder to supply.
-- ---------------------------------------------------------------------------
UPDATE suppliers SET
  type = 'manufacturer',
  notes = 'Zero footprint in synced Gmail — legal name/address/bank/terms ALL MISSING (likely WeChat / pre-sync). Founder to supply. Carried-over contact: Maggie / sales03@wumes.com.'
WHERE name = 'Wumes';

-- ---------------------------------------------------------------------------
-- Pigeons & Thread — Canadian R&D/first-run STUDIO that also manufactures (RHW/Stella + gaffs)
-- ---------------------------------------------------------------------------
UPDATE suppliers SET
  type = 'studio',
  company_name = 'Pigeons & Thread Manufacturing Inc.',
  contact_name = 'Cat Essiambre',
  address_line1 = '1024 Dupont Street, Unit 22',
  city = 'Toronto', region = 'Ontario', postal_code = 'M6H 1Z6', country = 'Canada',
  phone = '647.992.7541',
  website = 'www.pigeonsandthread.com',
  incoterms = 'N/A (local Toronto)',
  notes = 'Canadian R&D + first-run studio; ALSO manufactures (RHW/Stella, gaff samples, sports-bra band, fabric R&D via Swatchon). Billed via QuickBooks (domestic, no T/T). Net terms TBD.'
WHERE name = 'Pigeons and Thread';

-- ---------------------------------------------------------------------------
-- Joyce — independent pre-shipment QC inspector (galenfixqc). NEW row.
-- ---------------------------------------------------------------------------
INSERT INTO suppliers (name, type, company_name, contact_name, email, sku_prefixes, notes)
SELECT 'Joyce', 'qc_inspector', NULL, 'Joyce', '530850074@qq.com', '{}',
  'Independent pre-shipment QC inspector (galenfixqc). Inspects production before Harry''s freight pickup. The QC charts (generate_qc_sheet) are sent here.'
WHERE NOT EXISTS (SELECT 1 FROM suppliers WHERE lower(name) = 'joyce');

-- ---------------------------------------------------------------------------
-- Harry (CLH Express) — freight forwarder; invoiced via SG International Logistics. NEW row.
-- ---------------------------------------------------------------------------
INSERT INTO suppliers (
  name, type, company_name, contact_name, email, whatsapp, website,
  address_line1, city, country, bank_name, bank_address, swift, account_number,
  beneficiary_name, sku_prefixes, notes)
SELECT
  'Harry (CLH Express)', 'freight_forwarder', 'SG International Logistics Shanghai Co Ltd',
  'Harry Sha', 'harry@clhexpress.com', '+86 1595815615', 'clhexpress.com',
  'Room 605, Building A, Tonglian Innovation Industrial Park, Qingpu District', 'Shanghai', 'China',
  'Bank of China, Shanghai Xujing Branch', 'No.205, Jinghua Road, Xujing Zhen, Qingpu District, Shanghai',
  'BKCHCNBJ300', '449484675075', 'SG INTERNATIONAL LOGISTICS SHANGHAI CO LTD', '{}',
  'Ocean freight + customs/duties, China/Vietnam -> US/Canada; handles the post-EXW leg. T/T per shipment. NAME MISMATCH: brand CLH Express (Harry) but invoiced as SG International Logistics — confirm relationship. Verify WhatsApp digit count. Sample inv PK251103 = USD 16,351.31 (freight 2,869.50 + duties 13,481.81, 95 CTN).'
WHERE NOT EXISTS (SELECT 1 FROM suppliers WHERE lower(name) = 'harry (clh express)');
