#!/usr/bin/env node
/**
 * DealHub Playbook Export → Excel
 *
 * Usage:
 *   node export_playbook.js [base-url]
 *
 * Reads session from session_current.json (captured by login script).
 * Exports the ACTIVE version's playbooks to Excel.
 */

'use strict';

const { request: pwReq } = require('playwright');
const { chromium }       = require('playwright');
const XLSX               = require('xlsx');
const fs                 = require('fs');
const path               = require('path');
const os                 = require('os');

const SESSION_FILE = path.join(__dirname, 'session_current.json');

// Resolve base URL from arg or saved session
let BASE_URL = process.argv[2];
if (!BASE_URL) {
  if (fs.existsSync(SESSION_FILE)) {
    const s = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
    if (s._host) BASE_URL = `https://${s._host}`;
  }
}
if (!BASE_URL) { console.error('No base URL. Pass as arg or log in first.'); process.exit(1); }
BASE_URL = BASE_URL.replace(/\/$/, '');

const OUT_FILE = path.join(
  os.homedir(), 'Downloads',
  `playbook_export_${new Date().toISOString().slice(0, 10)}.xlsx`
);

// ── Session ───────────────────────────────────────────────────────────────────

async function ensureSession() {
  if (fs.existsSync(SESSION_FILE)) {
    try {
      const raw = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
      const ctx = await pwReq.newContext({
        baseURL: BASE_URL,
        storageState: raw,
        extraHTTPHeaders: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0' },
      });
      const res = await ctx.get('/versions/admin?isArchived=false&versionsScreen=true');
      if (res.ok()) { await ctx.dispose(); console.log('Session valid'); return; }
      await ctx.dispose();
    } catch {}
  }

  console.log(`\nOpening browser for login → ${BASE_URL}`);
  console.log('Log in, navigate to any admin page — script auto-continues.\n');

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: null });
  const page    = await context.newPage();
  let saved = false;

  page.on('response', async (response) => {
    if (saved || response.status() !== 200) return;
    const url = response.url();
    if (!url.includes('dealhub.io')) return;
    if (!/\/(versions|playbooks?|outputdocs|workflowSpecialRule)/.test(url)) return;
    try {
      const state = await context.storageState();
      const host  = new URL(url).hostname;
      fs.writeFileSync(SESSION_FILE, JSON.stringify({ ...state, _host: host }, null, 2));
      saved = true;
      console.log(`Session captured for: ${host}. Closing browser...`);
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
async function getCtx() {
  if (_ctx) return _ctx;
  const raw = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
  _ctx = await pwReq.newContext({
    baseURL: BASE_URL,
    storageState: raw,
    extraHTTPHeaders: {
      Accept: 'application/json',
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
    },
  });
  return _ctx;
}

async function get(urlPath) {
  const ctx = await getCtx();
  try {
    const res = await ctx.get(urlPath, { timeout: 30000 });
    if (!res.ok()) {
      const body = await res.text().catch(() => '');
      console.warn(`  WARN: GET ${urlPath} → ${res.status()}: ${body.slice(0, 120)}`);
      return null;
    }
    return res.json();
  } catch (e) {
    console.warn(`  ERROR: GET ${urlPath} → ${e.message}`);
    return null;
  }
}

// ── Flatten playbook ──────────────────────────────────────────────────────────

function stripHtml(s) {
  return String(s || '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
}

function flattenPlaybook(pb, vName) {
  const playbookName = pb.name || pb.displayedName || '';
  const rows = {
    questions:  [],
    answers:    [],
    groups:     [],
    conditions: [],
  };

  // DealHub structure: solutions[] = groups, solutionAttributes[] = questions
  const solutions = pb.solutions || pb.groups || pb.playbookGroups || [];
  for (const g of solutions) {
    const groupName  = g.name || g.groupName || '';
    const groupOrder = g.ordinal ?? g.order ?? g.displayOrder ?? '';
    const groupType  = g.groupType || g.type || '';
    rows.groups.push([vName, playbookName, groupName, groupOrder, groupType, g.guid || '']);

    const attrs = g.solutionAttributes || g.questions || g.playbookQuestions || [];
    for (const q of attrs) {
      const qName    = q.name || '';
      const qLabel   = stripHtml(q.question || q.label || q.name || '');
      const qType    = q.type || '';
      const required = q.isMandatory ?? q.required ?? '';
      const qOrder   = q.ordinalValue ?? q.order ?? '';
      const qGuid    = q.guid || '';
      const tooltip  = stripHtml(q.tooltip || q.helpText || '');
      const hidden   = q.hidden ?? '';
      const readOnly = q.readOnly ?? '';
      const showMode = q.showMode || '';
      const multiSel = q.multiSelect ?? '';
      const defVal   = q.defaultValue ?? '';

      rows.questions.push([
        vName, playbookName, groupName, qOrder, qName, qLabel, qType,
        required, hidden, readOnly, showMode, multiSel, defVal, tooltip, qGuid,
      ]);

      // Answer options: value is [{id, text}] for single/multi select
      const opts = Array.isArray(q.value) ? q.value : [];
      for (const o of opts) {
        const oText = o.text || o.label || '';
        const oId   = o.id  ?? '';
        rows.answers.push([vName, playbookName, groupName, qName, oText, oId]);
      }

      // Conditional rules
      const conds = q.conditionalRules || q.conditions || [];
      for (const c of conds) {
        if (!c || typeof c !== 'object') continue;
        const expr = c.expression || c.rule || c.condition || JSON.stringify(c);
        rows.conditions.push([vName, playbookName, groupName, qName, expr]);
      }

      // Presentation rules
      const prules = q.presentationRules || [];
      for (const c of prules) {
        if (!c || typeof c !== 'object') continue;
        const expr = `[PRESENTATION] ${c.expression || c.rule || JSON.stringify(c)}`;
        rows.conditions.push([vName, playbookName, groupName, qName, expr]);
      }
    }
  }

  return rows;
}

// ── Excel ─────────────────────────────────────────────────────────────────────

function buildExcel(all) {
  const wb = XLSX.utils.book_new();

  // Questions sheet
  const qHdr = [
    'Version', 'Playbook', 'Group', 'Order', 'Field Name', 'Label', 'Type',
    'Mandatory', 'Hidden', 'ReadOnly', 'ShowMode', 'MultiSelect', 'Default', 'Tooltip', 'GUID',
  ];
  const qRows = [qHdr, ...all.flatMap(r => r.questions)];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(qRows), 'Questions');

  // Answer Options sheet
  const aHdr = ['Version', 'Playbook', 'Group', 'Question', 'Text', 'ID'];
  const aRows = [aHdr, ...all.flatMap(r => r.answers)];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aRows), 'Answer Options');

  // Groups sheet
  const gHdr = ['Version', 'Playbook', 'Group', 'Order', 'Type', 'GUID'];
  const gRows = [gHdr, ...all.flatMap(r => r.groups)];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(gRows), 'Groups');

  // Conditions sheet
  if (all.flatMap(r => r.conditions).length > 0) {
    const cHdr = ['Version', 'Playbook', 'Group', 'Question', 'Condition'];
    const cRows = [cHdr, ...all.flatMap(r => r.conditions)];
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(cRows), 'Conditions');
  }

  XLSX.writeFile(wb, OUT_FILE);
  console.log(`\nExcel written → ${OUT_FILE}`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

(async () => {
  await ensureSession();

  console.log(`\nFetching versions from ${BASE_URL}...`);
  const vData = await get('/versions/admin?isArchived=false&versionsScreen=true');
  const versions = vData?.versions || vData?.data || vData || [];
  const vList    = Array.isArray(versions) ? versions : [];

  const active = vList.filter(v => {
    const s = (v.status || v.versionStatus || '').toUpperCase();
    return s === 'ACTIVE' || s === 'DRAFT';
  });

  console.log(`  ${vList.length} total → ${active.length} ACTIVE/DRAFT`);
  if (!active.length) {
    // Fallback: just take the first version
    console.log('  No ACTIVE/DRAFT found — using first version');
    if (vList.length) active.push(vList[0]);
    else { console.error('No versions found'); process.exit(1); }
  }

  const allRows = [];

  for (const v of active) {
    const vGuid = v.guid || v.versionGUID || v.id;
    const vName = v.name || v.versionName || vGuid;
    const vStat = v.status || v.versionStatus || '';
    console.log(`\n[${vStat}] ${vName} (${vGuid})`);

    const pbList = await get(`/playbooks?versionGUID=${vGuid}`);
    const playbooks = Array.isArray(pbList) ? pbList
      : Array.isArray(pbList?.playbooks) ? pbList.playbooks
      : Array.isArray(pbList?.data) ? pbList.data
      : [];

    console.log(`  ${playbooks.length} playbooks`);

    for (const pbMeta of playbooks) {
      const pbGuid = pbMeta.guid || pbMeta.playbookGUID || pbMeta.id;
      const pbName = pbMeta.name || pbMeta.playbookName || pbGuid;
      process.stdout.write(`    → ${pbName}... `);

      const pb = await get(`/playbook?playbookGUID=${pbGuid}&versionGUID=${vGuid}`);
      if (!pb) { console.log('SKIP (no data)'); continue; }

      const flat = flattenPlaybook(pb, vName);
      allRows.push(flat);
      console.log(`${flat.questions.length} questions, ${flat.answers.length} answer options`);
    }
  }

  const totalQ = allRows.reduce((s, r) => s + r.questions.length, 0);
  const totalA = allRows.reduce((s, r) => s + r.answers.length, 0);
  const totalG = allRows.reduce((s, r) => s + r.groups.length, 0);

  console.log(`\n── Summary ──`);
  console.log(`  Groups:   ${totalG}`);
  console.log(`  Questions: ${totalQ}`);
  console.log(`  Answer options: ${totalA}`);

  if (!totalQ) {
    // Debug: dump raw structure of first playbook
    console.log('\nNo questions found — dumping raw first playbook keys for debug:');
    const v = active[0];
    const vGuid = v.guid || v.versionGUID || v.id;
    const pbList = await get(`/playbooks?versionGUID=${vGuid}`);
    const pbs = Array.isArray(pbList) ? pbList : pbList?.playbooks || pbList?.data || [];
    if (pbs.length) {
      const pbGuid = pbs[0].guid || pbs[0].playbookGUID;
      const pb = await get(`/playbook?playbookGUID=${pbGuid}&versionGUID=${vGuid}`);
      console.log(JSON.stringify(pb, null, 2).slice(0, 2000));
    }
  }

  buildExcel(allRows);

  if (_ctx) await _ctx.dispose();
})().catch(e => { console.error('Error:', e.message); process.exit(1); });
