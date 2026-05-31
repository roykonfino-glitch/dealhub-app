#!/usr/bin/env node
/**
 * DealHub Product Tag Impact Analysis
 *
 * Usage:
 *   node tag_impact_analysis.js <products-excel-path> [base-url]
 */

'use strict';

const { chromium }       = require('playwright');
const { request: pwReq } = require('playwright');
const XLSX               = require('xlsx');
const fs                 = require('fs');
const path               = require('path');

const PRODUCTS_FILE = process.argv[2];
const BASE_URL      = (process.argv[3] || 'https://service-us2.dealhub.io').replace(/\/$/, '');
const SESSION_FILE  = path.join(__dirname, 'session_us2.json');
const OUT_FILE      = path.join(
  require('os').homedir(), 'Downloads',
  `tag_impact_${new Date().toISOString().slice(0,10)}.xlsx`
);

if (!PRODUCTS_FILE || !fs.existsSync(PRODUCTS_FILE)) {
  console.error('Usage: node tag_impact_analysis.js <products.xlsx> [base-url]');
  process.exit(1);
}

// ── Session ───────────────────────────────────────────────────────────────────

async function ensureSession() {
  if (fs.existsSync(SESSION_FILE)) {
    try {
      const ctx = await pwReq.newContext({
        baseURL: BASE_URL,
        storageState: JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8')),
        extraHTTPHeaders: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0' },
      });
      // Validate by hitting a real admin endpoint instead of /security/timeLeft
      const res = await ctx.get('/versions/admin?isArchived=false&versionsScreen=true');
      if (res.ok()) {
        console.log('Session valid');
        await ctx.dispose();
        return;
      }
      await ctx.dispose();
    } catch {}
  }

  console.log(`\nOpening browser for login → ${BASE_URL}`);
  console.log('Log in, navigate to any admin page — the script auto-continues.\n');

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: null });
  const page    = await context.newPage();
  let saved = false;

  page.on('response', async (response) => {
    if (saved || response.status() !== 200) return;
    const url = response.url();
    if (!url.includes('dealhub.io')) return;
    if (!/\/(versions|outputdocs|playbooks|workflowSpecialRule|submitValidation)/.test(url)) return;
    try {
      const state = await context.storageState();
      fs.writeFileSync(SESSION_FILE, JSON.stringify(state, null, 2));
      saved = true;
      console.log(`Session captured. Closing browser...`);
    } catch {}
  });

  await page.goto(`${BASE_URL}/ws`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await new Promise(resolve => {
    const iv = setInterval(() => { if (saved) { clearInterval(iv); resolve(); } }, 500);
    setTimeout(() => { clearInterval(iv); resolve(); }, 300000);
  });
  await browser.close();
}

// ── API ───────────────────────────────────────────────────────────────────────

let _ctx = null;
async function api() {
  if (_ctx) return _ctx;
  _ctx = await pwReq.newContext({
    baseURL: BASE_URL,
    storageState: JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8')),
    extraHTTPHeaders: {
      Accept: 'application/json',
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
    },
  });
  return _ctx;
}

async function get(urlPath) {
  const ctx = await api();
  const res = await ctx.get(urlPath);
  if (!res.ok()) { console.warn(`  WARN ${res.status()} ${urlPath}`); return null; }
  return res.json();
}

// ── Product tags ─────────────────────────────────────────────────────────────

function extractProductTags(filePath) {
  const wb   = XLSX.readFile(filePath);
  const ws   = wb.Sheets['Products'];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });

  let hdrIdx = -1;
  for (let i = 0; i < Math.min(rows.length, 5); i++) {
    if (rows[i].some(v => String(v).toUpperCase().includes('SKU'))) { hdrIdx = i; break; }
  }
  if (hdrIdx === -1) throw new Error('Cannot find header row');

  const headers = rows[hdrIdx].map(h => String(h).trim().toUpperCase());
  const skuIdx  = headers.indexOf('SKU');
  const nameIdx = headers.indexOf('NAME');
  const primIdx = headers.findIndex(h => h.includes('PRIMARY') && h.includes('TAG'));
  const tagsIdx = headers.findIndex(h => h === 'TAGS');

  const products = [];
  const allTags  = new Set();

  for (let i = hdrIdx + 1; i < rows.length; i++) {
    const row  = rows[i];
    const sku  = String(row[skuIdx] || '').trim();
    const name = String(row[nameIdx] || '').trim();
    if (!sku && !name) continue;
    const primary = String(row[primIdx] || '').trim();
    const tagStr  = String(row[tagsIdx] || '').trim();
    const tags    = new Set();
    if (primary) tags.add(primary);
    if (tagStr) tagStr.split(',').map(t => t.trim()).filter(Boolean).forEach(t => tags.add(t));
    tags.forEach(t => allTags.add(t));
    products.push({ sku, name, primary, tags: [...tags] });
  }

  console.log(`Products: ${products.length} | Unique tags: ${allTags.size}`);
  return { products, allTags: [...allTags].sort() };
}

// ── DealHub fetch ─────────────────────────────────────────────────────────────

async function fetchData(allTags) {
  const tagSet = new Set(allTags.map(t => t.toLowerCase()));

  console.log('\nFetching versions (ACTIVE + DRAFT only)...');
  const allVersions = await get('/versions/admin?isArchived=false&versionsScreen=true') || [];
  const versions    = allVersions.filter(v => ['ACTIVE','DRAFT'].includes(v.status));
  console.log(`  ${allVersions.length} total → ${versions.length} ACTIVE/DRAFT`);

  const workflowHits = [];
  const submitHits   = [];

  for (const v of versions) {
    const guid  = v.guid || v.versionGUID;
    const vname = v.name || v.displayedName || guid;
    const vstatus = v.status;
    process.stdout.write(`  [${vstatus}] ${vname} ... `);

    // Workflow rules
    const wf = await get(`/workflowSpecialRule?versionGUID=${guid}`);
    const rules = wf?.specialRuleWorkflowBlock?.specialRules || [];
    for (const rule of rules) {
      // Direct tag relations (most reliable)
      const directTags = (rule.tagRelations || []).map(tr => tr.tag).filter(t => tagSet.has(t.toLowerCase()));
      // Also text-search rule expression
      const ruleExpr = rule.rule || '';
      const exprTags = allTags.filter(t => {
        const esc = t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return new RegExp(`(?<![\\w:])${esc}(?![\\w])`, 'i').test(ruleExpr);
      });
      const matchedTags = [...new Set([...directTags, ...exprTags])];
      if (matchedTags.length > 0) {
        workflowHits.push({
          version: vname, versionStatus: vstatus,
          ruleName: rule.description || rule.id || '(unnamed)',
          ruleGuid: rule.guid || '',
          condition: ruleExpr,
          matchedTags: matchedTags.join(', '),
          matchSource: directTags.length > 0 ? 'tagRelation' : 'expression',
        });
      }
    }

    // Submit validations
    const sv  = await get(`/submitValidationSettings?versionGUID=${guid}`);
    const svRules = sv?.submitValidationRules || [];
    for (const rule of svRules) {
      const directTags = (rule.tagRelations || []).map(tr => tr.tag).filter(t => tagSet.has(t.toLowerCase()));
      const activeWhen = rule.activeWhen || '';
      const exprTags   = allTags.filter(t => {
        const esc = t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return new RegExp(`(?<![\\w:])${esc}(?![\\w])`, 'i').test(activeWhen);
      });
      const matchedTags = [...new Set([...directTags, ...exprTags])];
      if (matchedTags.length > 0) {
        submitHits.push({
          version: vname, versionStatus: vstatus,
          ruleName: rule.description || rule.guid || '(unnamed)',
          ruleGuid: rule.guid || '',
          condition: activeWhen,
          message: (rule.validationMessage || '').replace(/<[^>]+>/g, '').slice(0, 200),
          matchedTags: matchedTags.join(', '),
        });
      }
    }

    console.log(`${rules.length} workflow rules, ${svRules.length} submit rules`);
  }

  // Output documents — use ACTIVE version
  const activeVersion = versions.find(v => v.status === 'ACTIVE') || versions[0];
  const docHits = [];
  if (activeVersion) {
    const avGuid = activeVersion.guid || activeVersion.versionGUID;
    console.log(`\nFetching output docs for version "${activeVersion.name || activeVersion.displayedName}"...`);
    const docsRes = await get(`/outputdocs?versionGUID=${avGuid}`);
    const docList = docsRes?.outputDocuments || [];
    console.log(`  ${docList.length} output documents`);

    for (const doc of docList) {
      const content = await get(`/outputData/edit?guid=${doc.guid}&versionGUID=${avGuid}`);
      if (!content) continue;
      const contentStr = JSON.stringify(content);

      // Extract tags from the `tags` array in the doc
      const docTags = (content.tags || []).map(t => t.tag || t.name || t).filter(Boolean);

      // Find which product tags are referenced
      const matchedTags = allTags.filter(t => {
        const esc = t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return new RegExp(`"tag"\\s*:\\s*"${esc}"`, 'i').test(contentStr);
      });

      if (matchedTags.length > 0) {
        docHits.push({
          docName: doc.name || doc.displayName || doc.guid,
          docGuid: doc.guid,
          version: activeVersion.name || activeVersion.displayedName,
          matchedTags: matchedTags.join(', '),
          tagCount: matchedTags.length,
          docTagsDefined: docTags.join(', '),
        });
      }
    }
  }

  return { workflowHits, submitHits, docHits };
}

// ── Excel output ──────────────────────────────────────────────────────────────

function buildExcel({ products, allTags, workflowHits, submitHits, docHits }) {
  const wb = XLSX.utils.book_new();

  // Build tag usage counts
  const usage = {};
  allTags.forEach(t => { usage[t] = { products: 0, workflow: 0, submit: 0, outputDoc: 0 }; });
  products.forEach(p => p.tags.forEach(t => { if (usage[t]) usage[t].products++; }));
  workflowHits.forEach(h => h.matchedTags.split(', ').forEach(t => { if (usage[t]) usage[t].workflow++; }));
  submitHits.forEach(h => h.matchedTags.split(', ').forEach(t => { if (usage[t]) usage[t].submit++; }));
  docHits.forEach(h => h.matchedTags.split(', ').forEach(t => { if (usage[t]) usage[t].outputDoc++; }));

  // ── Sheet 1: Tag Summary ─────────────────────────────────────────────────
  const summaryHdr = ['Tag', 'Products Using Tag', 'Workflow Rules', 'Submit Validations', 'Output Documents', 'Total References', 'Status'];
  const summaryData = allTags.map(tag => {
    const u = usage[tag];
    const total = u.workflow + u.submit + u.outputDoc;
    const status = total === 0
      ? (u.products > 0 ? 'ORPHANED' : 'UNUSED')
      : 'ACTIVE';
    return [tag, u.products, u.workflow, u.submit, u.outputDoc, total, status];
  });
  // Orphaned first, then by total desc
  summaryData.sort((a, b) => {
    if (a[6] === 'ORPHANED' && b[6] !== 'ORPHANED') return -1;
    if (b[6] === 'ORPHANED' && a[6] !== 'ORPHANED') return 1;
    return b[5] - a[5];
  });
  const summarySheet = XLSX.utils.aoa_to_sheet([summaryHdr, ...summaryData]);
  summarySheet['!cols'] = [{ wch: 40 }, { wch: 18 }, { wch: 14 }, { wch: 18 }, { wch: 16 }, { wch: 16 }, { wch: 12 }];
  XLSX.utils.book_append_sheet(wb, summarySheet, 'Tag Summary');

  // ── Sheet 2: Workflow Rules ──────────────────────────────────────────────
  const wfHdr = ['Version', 'Status', 'Rule Name', 'Matched Tags', 'Condition Expression'];
  const wfData = workflowHits.length > 0
    ? workflowHits.map(h => [h.version, h.versionStatus, h.ruleName, h.matchedTags, h.condition.slice(0, 500)])
    : [['(no workflow rules reference product tags)', '', '', '', '']];
  const wfSheet = XLSX.utils.aoa_to_sheet([wfHdr, ...wfData]);
  wfSheet['!cols'] = [{ wch: 20 }, { wch: 8 }, { wch: 45 }, { wch: 40 }, { wch: 90 }];
  XLSX.utils.book_append_sheet(wb, wfSheet, 'Workflow Rules');

  // ── Sheet 3: Submit Validations ──────────────────────────────────────────
  const svHdr = ['Version', 'Status', 'Rule Name', 'Matched Tags', 'Condition (activeWhen)', 'Validation Message'];
  const svData = submitHits.length > 0
    ? submitHits.map(h => [h.version, h.versionStatus, h.ruleName, h.matchedTags, h.condition.slice(0, 300), h.message])
    : [['(no submit validations reference product tags)', '', '', '', '', '']];
  const svSheet = XLSX.utils.aoa_to_sheet([svHdr, ...svData]);
  svSheet['!cols'] = [{ wch: 20 }, { wch: 8 }, { wch: 40 }, { wch: 35 }, { wch: 70 }, { wch: 60 }];
  XLSX.utils.book_append_sheet(wb, svSheet, 'Submit Validations');

  // ── Sheet 4: Output Documents ────────────────────────────────────────────
  const docHdr = ['Document Name', 'Version', 'Tags Referenced', 'Tag Count'];
  const docData = docHits.length > 0
    ? docHits.map(h => [h.docName, h.version, h.matchedTags, h.tagCount])
    : [['(no output documents reference product tags)', '', '', '']];
  const docSheet = XLSX.utils.aoa_to_sheet([docHdr, ...docData]);
  docSheet['!cols'] = [{ wch: 40 }, { wch: 15 }, { wch: 80 }, { wch: 12 }];
  XLSX.utils.book_append_sheet(wb, docSheet, 'Output Documents');

  // ── Sheet 5: Products ────────────────────────────────────────────────────
  const prodHdr = ['SKU', 'Name', 'Primary Tag', 'All Tags'];
  const prodData = products.map(p => [p.sku, p.name, p.primary, p.tags.join(', ')]);
  const prodSheet = XLSX.utils.aoa_to_sheet([prodHdr, ...prodData]);
  prodSheet['!cols'] = [{ wch: 18 }, { wch: 50 }, { wch: 25 }, { wch: 90 }];
  XLSX.utils.book_append_sheet(wb, prodSheet, 'Products');

  XLSX.writeFile(wb, OUT_FILE);
  return OUT_FILE;
}

// ── Main ──────────────────────────────────────────────────────────────────────

(async () => {
  try {
    console.log(`Loading products: ${PRODUCTS_FILE}`);
    const { products, allTags } = extractProductTags(PRODUCTS_FILE);

    await ensureSession();

    const { workflowHits, submitHits, docHits } = await fetchData(allTags);

    console.log(`\nCross-reference results:`);
    console.log(`  Workflow rule hits: ${workflowHits.length}`);
    console.log(`  Submit validation hits: ${submitHits.length}`);
    console.log(`  Output doc hits: ${docHits.length}`);

    const outFile = buildExcel({ products, allTags, workflowHits, submitHits, docHits });

    // Orphan summary
    const usedTags = new Set([
      ...workflowHits.flatMap(h => h.matchedTags.split(', ')),
      ...submitHits.flatMap(h => h.matchedTags.split(', ')),
      ...docHits.flatMap(h => h.matchedTags.split(', ')),
    ]);
    const orphaned = allTags.filter(t => !usedTags.has(t));

    console.log(`\n── Final Summary ──`);
    console.log(`  Total tags: ${allTags.length}`);
    console.log(`  Active in rules/docs: ${usedTags.size}`);
    console.log(`  Orphaned (only on products, never referenced): ${orphaned.length}`);
    console.log(`\nExcel → ${outFile}`);
  } catch (e) {
    console.error('Fatal:', e.message);
    process.exit(1);
  }
})();
