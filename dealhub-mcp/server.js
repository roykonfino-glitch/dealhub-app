#!/usr/bin/env node
/**
 * DealHub Output Document MCP Server — dealhub-output-doc-mcp v1.0.0
 *
 * Uses Playwright's APIRequestContext so all requests share Chrome's
 * TLS fingerprint and pass through DealHub's Imperva/Incapsula WAF.
 *
 * Session setup:
 *   1. Run `node capture.js https://poc.dealhub.io` once to log in
 *      → writes session_state.json automatically
 *   2. This server loads session_state.json on start
 *   3. Set DEALHUB_BASE_URL to override the default
 *
 * Tools available:
 *   list_documents          — list existing output documents
 *   create_document         — create metadata record, return GUID
 *   get_document            — read full document JSON
 *   save_document           — gzip-compress and POST to /outputData/save
 *   add_body_section        — append TEXT/IMAGE/TABLE/SIGNATURE/SUBTEMPLATE
 *   set_section_condition   — set show/hide condition on a content item
 *   build_document_from_spec — one-shot: create + populate a full template
 */

const { McpServer }            = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z }       = require('zod');
const { request: pwRequest } = require('playwright');
const zlib        = require('zlib');
const path        = require('path');
const fs          = require('fs');

const BASE_URL     = process.env.DEALHUB_BASE_URL || 'https://poc.dealhub.io';
const SESSION_FILE = path.join(__dirname, 'session_state.json');

// ── Playwright API context (singleton, lazy-init) ─────────────────────────────

let _ctx = null;

async function getCtx() {
  if (_ctx) return _ctx;
  if (!fs.existsSync(SESSION_FILE)) {
    throw new Error(
      'session_state.json not found. Run: node capture.js https://poc.dealhub.io\n' +
      'Log in to DealHub, then press Ctrl+C. The file will be created automatically.'
    );
  }
  const storageState = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
  _ctx = await pwRequest.newContext({
    baseURL: BASE_URL,
    storageState,
    extraHTTPHeaders: {
      Accept:  'application/json',
      Origin:  BASE_URL,
      Referer: BASE_URL + '/',
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36',
    },
  });
  return _ctx;
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

async function apiGet(urlPath) {
  const ctx = await getCtx();
  const res = await ctx.get(urlPath);
  if (!res.ok()) {
    const t = await res.text();
    if (t.includes('"redirect":true')) {
      _ctx = null; // session expired — force re-init next call
      throw new Error('Session expired. Re-run: node capture.js https://poc.dealhub.io and log in again.');
    }
    throw new Error(`GET ${urlPath} → ${res.status()}: ${t.slice(0, 300)}`);
  }
  return res.json();
}

async function apiMultipart(urlPath, fieldName, value) {
  const ctx = await getCtx();
  const res = await ctx.post(urlPath, {
    multipart: { [fieldName]: value },
  });
  if (!res.ok()) {
    const t = await res.text();
    throw new Error(`POST ${urlPath} (multipart) → ${res.status()}: ${t.slice(0, 300)}`);
  }
  return res.text();
}

async function apiGzipPost(urlPath, payload) {
  const ctx = await getCtx();
  const buf = await new Promise((ok, fail) =>
    zlib.gzip(Buffer.from(JSON.stringify(payload), 'utf8'), (e, b) => e ? fail(e) : ok(b))
  );
  const res = await ctx.post(urlPath, {
    headers: {
      'Content-Type':     'application/json',
      'Content-Encoding': 'gzip',
    },
    data: buf,
  });
  if (!res.ok()) {
    const t = await res.text();
    throw new Error(`POST ${urlPath} (gzip) → ${res.status()}: ${t.slice(0, 300)}`);
  }
  const text = await res.text();
  try { return JSON.parse(text); } catch { return text; }
}

// ── ID generation — DealHub uses Date.now() for part GUIDs ───────────────────

function dhId() { return Date.now().toString(); }

// ── Part builders ─────────────────────────────────────────────────────────────

function makeTextPart(title, items) {
  const id = dhId();
  const content = items.map((ci, i) => ({
    guid:            (Date.now() + i).toString(),
    title:           ci.title || title,
    desc:            ci.html  || ci.desc || '',
    url:             '',
    condition:       ci.condition ?? null,
    pageBreakAfter:  ci.pageBreakAfter || false,
    footerHR:        ci.footerHR ?? false,
    lockedForChanges: false,
  }));
  return {
    guid:             id,
    selectedGuid:     content[0].guid,
    template:         'docComposerTextSection.html',
    expanded:         true,
    shown:            true,
    title,
    type:             'TEXT',
    includePageNumber: false,
    content,
  };
}

function makeImagePart(title, imageUrl, condition) {
  const id        = dhId();
  const contentId = (Date.now() + 1).toString();
  return {
    guid:             id,
    selectedGuid:     contentId,
    template:         'docComposerImageSection.html',
    expanded:         true,
    shown:            true,
    title,
    type:             'IMAGE',
    includePageNumber: false,
    content: [{
      guid:            contentId,
      title,
      desc:            '',
      url:             imageUrl || '',
      condition:       condition ?? null,
      pageBreakAfter:  false,
      footerHR:        false,
      lockedForChanges: false,
    }],
  };
}

// Default column set for PRODUCTS_TABLE — mirrors what the DealHub UI creates.
// Toggle `active: true` on the columns you want visible.
const DEFAULT_TABLE_COLUMNS = [
  { label: 'ORDINAL',             displayName: 'Ordinal',            active: false, headerAlign: 'LEFT',  bodyAlign: 'RIGHT' },
  { label: 'GROUP',               displayName: 'Group',              active: false, headerAlign: 'LEFT',  bodyAlign: 'LEFT'  },
  { label: 'ITEM_NAME',           displayName: 'Item Name',          active: true,  headerAlign: 'LEFT',  bodyAlign: 'LEFT'  },
  { label: 'DESCRIPTION',         displayName: 'Description',        active: false, headerAlign: 'LEFT',  bodyAlign: 'LEFT'  },
  { label: 'SKU',                 displayName: 'SKU',                active: true,  headerAlign: 'LEFT',  bodyAlign: 'LEFT'  },
  { label: 'TAG',                 displayName: 'Tag',                active: false, headerAlign: 'LEFT',  bodyAlign: 'LEFT'  },
  { label: 'BASE_PRICE',          displayName: 'Base Price',         active: false, headerAlign: 'LEFT',  bodyAlign: 'RIGHT' },
  { label: 'DURATION',            displayName: 'Duration',           active: false, headerAlign: 'LEFT',  bodyAlign: 'RIGHT' },
  { label: 'QUANTITY',            displayName: 'Quantity',           active: false, headerAlign: 'LEFT',  bodyAlign: 'RIGHT' },
  { label: 'IS_RENEWABLE',        displayName: 'Is Renewable',       active: false, headerAlign: 'LEFT',  bodyAlign: 'LEFT'  },
  { label: 'START_DATE',          displayName: 'Start Date',         active: false, headerAlign: 'LEFT',  bodyAlign: 'LEFT'  },
  { label: 'END_DATE',            displayName: 'End Date',           active: false, headerAlign: 'LEFT',  bodyAlign: 'LEFT'  },
  { label: 'NUMBER',              displayName: 'Number',             active: false, headerAlign: 'LEFT',  bodyAlign: 'RIGHT' },
  { label: 'MULTIPLY_ALL_FACTORS',displayName: 'Factor',             active: true,  headerAlign: 'LEFT',  bodyAlign: 'RIGHT' },
  { label: 'LIST_PRICE',          displayName: 'List Price',         active: true,  headerAlign: 'LEFT',  bodyAlign: 'RIGHT' },
  { label: 'POSITIVE_LIST_PRICE', displayName: 'Positive List Price',active: false, headerAlign: 'LEFT',  bodyAlign: 'RIGHT' },
  { label: 'NEGATIVE_LIST_PRICE', displayName: 'Negative List Price',active: false, headerAlign: 'LEFT',  bodyAlign: 'RIGHT' },
  { label: 'PROMOTION_DISCOUNT',  displayName: 'Promo Discount',     active: false, headerAlign: 'LEFT',  bodyAlign: 'RIGHT' },
  { label: 'PROMOTION_DISCOUNT_PRCT', displayName: 'Promo Disc %',   active: false, headerAlign: 'LEFT',  bodyAlign: 'RIGHT' },
  { label: 'SPECIAL_DISCOUNT',    displayName: 'Special Discount',   active: false, headerAlign: 'LEFT',  bodyAlign: 'RIGHT' },
  { label: 'SPECIAL_DISCOUNT_PRCT',displayName: 'Special Disc %',    active: false, headerAlign: 'LEFT',  bodyAlign: 'RIGHT' },
  { label: 'USER_DISCOUNT',       displayName: 'User Discount',      active: false, headerAlign: 'LEFT',  bodyAlign: 'RIGHT' },
  { label: 'USER_DISCOUNT_PRCT',  displayName: 'User Disc %',        active: false, headerAlign: 'LEFT',  bodyAlign: 'RIGHT' },
  { label: 'DISCOUNT_PRCT',       displayName: 'Discount %',         active: true,  headerAlign: 'LEFT',  bodyAlign: 'RIGHT' },
  { label: 'DISCOUNT_$',          displayName: 'Discount $',         active: false, headerAlign: 'LEFT',  bodyAlign: 'RIGHT' },
  { label: 'NET_PRICE',           displayName: 'Net Price',          active: true,  headerAlign: 'LEFT',  bodyAlign: 'RIGHT' },
  { label: 'NET_PRICE_PER_UNIT',  displayName: 'Net Price / Unit',   active: false, headerAlign: 'LEFT',  bodyAlign: 'RIGHT' },
  { label: 'MSRP',                displayName: 'MSRP',               active: false, headerAlign: 'LEFT',  bodyAlign: 'RIGHT' },
  { label: 'MSRP_DISCOUNT',       displayName: 'MSRP Discount',      active: false, headerAlign: 'LEFT',  bodyAlign: 'RIGHT' },
].map(c => ({
  active:                   c.active,
  cellWidth:                0,
  displayName:              c.displayName,
  displayFirstName:         null,
  displaySecondName:        null,
  label:                    c.label,
  ordinal:                  0,
  sortable:                 true,
  groupColumnType:          'EMPTY',
  groupColumnFreeText:      '',
  groupColumnFormula:       '',
  displayFirstData:         null,
  displaySecondData:        null,
  presentationRule:         'false',
  cellDataWidth:            0,
  cellHeight:               0,
  maxCellHeight:            0,
  headerAlign:              c.headerAlign,
  bodyAlign:                c.bodyAlign,
  totalsRowLabel:           'N/A',
  showInTotalsRow:          false,
  enableSummarizeInTotalsRow: false,
}));

function makeTablePart(title, cfg = {}) {
  const id         = dhId();
  const partId     = (Date.now() + 1).toString();
  const tableType  = cfg.tableType || 'PRODUCTS_TABLE';

  // Allow caller to specify which column labels to activate
  const activeLabels = cfg.activeColumns || null;
  const columns = DEFAULT_TABLE_COLUMNS.map(col => ({
    ...col,
    active: activeLabels ? activeLabels.includes(col.label) : col.active,
    displayName: (cfg.columnNames || {})[col.label] || col.displayName,
  }));

  return {
    guid:             id,
    selectedGuid:     '',
    template:         'docComposerTableSection.html',
    expanded:         true,
    shown:            true,
    title,
    type:             'TABLE',
    tableType,
    tableParts: [{
      guid:                   partId,
      title:                  cfg.tableSectionTitle || 'Pricing Table',
      condition:              cfg.condition || 'true',
      usePresentationRule:    false,
      subject:                cfg.subject || '',
      showTotalListPrice:     cfg.showTotalListPrice  ?? true,
      totalListPriceName:     cfg.totalListPriceName  || 'Total List Price',
      showDiscount:           cfg.showDiscount        ?? true,
      discountName:           cfg.discountName        || 'Discount',
      discountType:           cfg.discountType        || 'DISCOUNT_PRCT',
      showTotalNegativePrice: cfg.showTotalNegativePrice ?? false,
      totalNegativePriceName: cfg.totalNegativePriceName || 'Total Negative Price',
      showTotalNetPrice:      cfg.showTotalNetPrice   ?? true,
      totalNetPriceName:      cfg.totalNetPriceName   || 'Total Net Price',
      showTablePerType:       cfg.showTablePerType    ?? false,
      content:                columns,
    }],
    includePageNumber: false,
  };
}

function makeSignaturePart(title, cfg = {}) {
  const id = dhId();
  return {
    guid:             id,
    selectedGuid:     id,
    template:         'docComposerSignatureSection.html',
    expanded:         true,
    shown:            true,
    title,
    type:             'SIGNATURE',
    signatories:      cfg.signatories || ['BUYER', 'SELLER'],
    includePageNumber: false,
    content:          [],
  };
}

function makeSubTemplatePart(title, templateGUID, condition) {
  const id = dhId();
  return {
    guid:             id,
    selectedGuid:     id,
    template:         'docComposerSubTemplateSection.html',
    expanded:         true,
    shown:            true,
    title,
    type:             'SUBTEMPLATE',
    subTemplateGUID:  templateGUID || '',
    condition:        condition ?? null,
    includePageNumber: false,
    content:          [],
  };
}

// ── Helper ────────────────────────────────────────────────────────────────────

function parsePages(state) {
  // /outputData/edit returns outputData as a JSON string; save needs pages as an object
  if (typeof state.outputData === 'string') return JSON.parse(state.outputData);
  if (state.outputData) return state.outputData;
  if (state.pages) return state.pages;
  throw new Error('Cannot find document pages in state');
}

function getSection(state, name) {
  return parsePages(state).sections.find(s => s.title === name);
}

function buildSavePayload(editResponse, versionGUID, docName) {
  const pages = parsePages(editResponse);
  return {
    versionGUID,
    guid:                     editResponse.outputDocGUID,
    pageSize:                 editResponse.selectedPageSize  || 'LETTER',
    pageOrientation:          editResponse.selectedPageOrientation || 'PORTRAIT',
    pages,
    defaultTablePart:         null,
    isRTL:                    editResponse.isRTL            ?? false,
    showOnce:                 editResponse.showOnce         ?? false,
    wrapTablesWithLines:      editResponse.wrapTablesWithLines ?? true,
    marginTop:                editResponse.marginTop        ?? 60,
    marginBottom:             editResponse.marginBottom     ?? 60,
    marginLeft:               editResponse.marginLeft       ?? 60,
    marginRight:              editResponse.marginRight      ?? 60,
    coverPagePresentationRule: editResponse.coverPagePresentationRule ?? 'true',
    changeLogRecords: [{
      date:                     Date.now(),
      username:                 'mcp-agent',
      userlogin:                'mcp@dealhub.io',
      impersonatorUserName:     null,
      impersonatorDealhubUser:  false,
      dealhubUser:              true,
      action:                   'Modification',
      object:                   'Output Document',
      objectName:               docName || editResponse.outputDocGUID,
      subObject: '', subObjectName: '', attribute: '', attributeName: '', fromValue: '', toValue: '',
    }],
  };
}

function createDocPayload(name, playbookGUID, versionGUID) {
  return {
    guid: null, name, displayName: null, playbookGUID,
    documentTypeGUID: null, externalFileGuid: null,
    comment: '', rule: '', assignType: 'ALWAYS', type: 'DOCUMENT',
    tagRelations: [], deletedDocumentTags: [],
    customFileNameTemplate: '%PROPOSAL_ID%', enableCustomFileName: null,
    changeLogRecords: [{
      date: Date.now(), username: 'mcp-agent', userlogin: 'mcp@dealhub.io',
      impersonatorUserName: null, impersonatorDealhubUser: false, dealhubUser: true,
      action: 'New', object: 'Output Document', objectName: name,
      subObject: '', subObjectName: '', attribute: '', attributeName: '', fromValue: '', toValue: '',
    }],
    versionGUID,
  };
}

// ── Server ────────────────────────────────────────────────────────────────────

const server = new McpServer({ name: 'dealhub-output-doc-mcp', version: '1.0.0' });

// ─── list_documents ──────────────────────────────────────────────────────────

server.tool(
  'list_documents',
  'List all output documents for a version/playbook',
  {
    versionGUID:  z.string().describe('Version GUID (e.g. 238a077587a3EAcC)'),
    playbookGUID: z.string().optional().describe('Filter by playbook GUID'),
  },
  async ({ versionGUID, playbookGUID }) => {
    const qs = new URLSearchParams({ docType: 'DOCUMENT', versionGUID });
    if (playbookGUID) qs.set('playbookGUID', playbookGUID);
    const result = await apiGet(`/outputdocs?${qs}`);
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  }
);

// ─── create_document ─────────────────────────────────────────────────────────

server.tool(
  'create_document',
  'Create a new output document record and return its GUID',
  {
    name:         z.string().describe('Display name'),
    playbookGUID: z.string().describe('Playbook GUID'),
    versionGUID:  z.string().describe('Version GUID'),
  },
  async ({ name, playbookGUID, versionGUID }) => {
    const raw = await apiMultipart('/outputdoc/createOrUpdate', 'outputDocument', JSON.stringify(createDocPayload(name, playbookGUID, versionGUID)));
    const docGUID = raw.replace(/"/g, '').trim();
    return { content: [{ type: 'text', text: docGUID }] };
  }
);

// ─── get_document ─────────────────────────────────────────────────────────────

server.tool(
  'get_document',
  'Fetch the current full document JSON (outputData + metadata)',
  {
    docGUID:     z.string().describe('Document GUID'),
    versionGUID: z.string().describe('Version GUID'),
  },
  async ({ docGUID, versionGUID }) => {
    const result = await apiGet(`/outputData/edit?guid=${docGUID}&versionGUID=${versionGUID}`);
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  }
);

// ─── save_document ────────────────────────────────────────────────────────────

server.tool(
  'save_document',
  'Gzip-compress and save the full document state',
  {
    documentState: z.record(z.unknown()).describe('Full document JSON as returned by get_document'),
    versionGUID:   z.string().describe('Version GUID'),
    docName:       z.string().optional().describe('Document name for changelog'),
  },
  async ({ documentState, versionGUID, docName }) => {
    const result = await apiGzipPost('/outputData/save', buildSavePayload(documentState, versionGUID, docName));
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  }
);

// ─── add_body_section ─────────────────────────────────────────────────────────

server.tool(
  'add_body_section',
  'Append a section to the Body of an existing document (TEXT, IMAGE, TABLE, SIGNATURE, SUBTEMPLATE)',
  {
    docGUID:         z.string().describe('Document GUID'),
    versionGUID:     z.string().describe('Version GUID'),
    type:            z.enum(['TEXT', 'IMAGE', 'TABLE', 'SIGNATURE', 'SUBTEMPLATE']).describe('Element type'),
    title:           z.string().describe('Section title visible in doc composer'),
    content: z.array(z.object({
      title:          z.string().optional().describe('Tab/version name (multiple = conditional tabs)'),
      html:           z.string().optional().describe('HTML content for TEXT elements'),
      url:            z.string().optional().describe('Image URL for IMAGE elements'),
      condition:      z.string().nullable().optional().describe('Show condition expression or null'),
      pageBreakAfter: z.boolean().optional(),
    })).optional(),
    tableConfig: z.object({
      tableType:          z.string().optional().default('PRODUCTS_TABLE'),
      tableSectionTitle:  z.string().optional().default('Pricing Table'),
      activeColumns:      z.array(z.string()).optional().describe('Array of column labels to show, e.g. ["ITEM_NAME","SKU","NET_PRICE"]'),
      columnNames:        z.record(z.string()).optional().describe('Override display names, e.g. {"NET_PRICE": "Annual Price"}'),
      showTotalListPrice: z.boolean().optional(),
      showDiscount:       z.boolean().optional(),
      showTotalNetPrice:  z.boolean().optional(),
      condition:          z.string().optional().describe('Table presentation condition, default "true"'),
    }).optional(),
    signatureConfig: z.object({
      signatories: z.array(z.string()).optional().describe('e.g. ["BUYER","SELLER"]'),
    }).optional(),
    subTemplateGUID: z.string().optional().describe('GUID of referenced sub-template document'),
  },
  async ({ docGUID, versionGUID, type, title, content = [], tableConfig = {}, signatureConfig = {}, subTemplateGUID }) => {
    const state = await apiGet(`/outputData/edit?guid=${docGUID}&versionGUID=${versionGUID}`);
    const body  = getSection(state, 'Body');
    if (!body) throw new Error('Body section not found in document');

    let part;
    switch (type) {
      case 'TEXT':
        part = makeTextPart(title, content.length ? content : [{ title, html: '' }]);
        break;
      case 'IMAGE':
        part = makeImagePart(title, content[0]?.url, content[0]?.condition);
        break;
      case 'TABLE':
        part = makeTablePart(title, tableConfig);
        break;
      case 'SIGNATURE':
        part = makeSignaturePart(title, signatureConfig);
        break;
      case 'SUBTEMPLATE':
        part = makeSubTemplatePart(title, subTemplateGUID, content[0]?.condition);
        break;
    }

    body.parts.push(part);
    await apiGzipPost('/outputData/save', buildSavePayload(state, versionGUID, title));
    return { content: [{ type: 'text', text: JSON.stringify({ sectionGUID: part.guid, title, type }) }] };
  }
);

// ─── set_section_condition ────────────────────────────────────────────────────

server.tool(
  'set_section_condition',
  'Set a show/hide condition expression on a content item in any section',
  {
    docGUID:      z.string().describe('Document GUID'),
    versionGUID:  z.string().describe('Version GUID'),
    sectionGUID:  z.string().optional().describe('Part GUID (from get_document)'),
    contentTitle: z.string().optional().describe('Content item title to match'),
    condition:    z.string().nullable().describe('Condition expression, e.g. "[GQ.Region] == \'US\'" or null to clear'),
  },
  async ({ docGUID, versionGUID, sectionGUID, contentTitle, condition }) => {
    const state = await apiGet(`/outputData/edit?guid=${docGUID}&versionGUID=${versionGUID}`);
    const pages = parsePages(state);
    let count = 0;
    for (const section of pages.sections) {
      for (const part of section.parts) {
        if (sectionGUID && part.guid !== sectionGUID) continue;
        for (const ci of (part.content || [])) {
          if (contentTitle && ci.title !== contentTitle) continue;
          ci.condition = condition;
          count++;
        }
        if (part.tableParts) {
          for (const tp of part.tableParts) {
            if (!contentTitle || tp.title === contentTitle) {
              tp.condition = condition ?? 'true';
              count++;
            }
          }
        }
      }
    }
    if (!count) throw new Error('No matching content item found — check sectionGUID or contentTitle');
    await apiGzipPost('/outputData/save', buildSavePayload(state, versionGUID, docGUID));
    return { content: [{ type: 'text', text: JSON.stringify({ updated: count, condition }) }] };
  }
);

// ─── build_document_from_spec ─────────────────────────────────────────────────

server.tool(
  'build_document_from_spec',

  `One-shot tool: analyze a sample document (PDF/Word/image) and create the complete
DealHub output document template automatically.

Design rules to follow:
- Page size: LETTER (US) or A4 (EU/APAC), PORTRAIT unless landscape specified
- Margins: 60px minimum (marginTop/Bottom/Left/Right use px, 96px ≈ 1 inch)
- Tables: 800px wide, #F2F2F2 header rows, 1px border, columns mathematically aligned
- Images: PNG at 2x-3x pixel size, max 1200×1200px — set url to resource URL
- Cover page: use cover_html for text, cover_imageUrl for logo/cover image
- Header: typically a logo image (header_imageUrl), repeated on every page
- Footer: typically legal text or address (footer_html), repeated on every page
- Conditions: "true" = always shown, "false" = never, "[Field] == 'Value'" = rule-based
- Conditional tabs: multiple content items in same section, each with different conditions
- Parameters: use [Param.Name] syntax for merge fields, %TOKEN% for proposal tokens`,

  {
    name:         z.string().describe('Document name in DealHub'),
    playbookGUID: z.string().describe('Playbook GUID (e.g. 2b7fE5300233940A)'),
    versionGUID:  z.string().describe('Version GUID (e.g. 238a077587a3EAcC)'),
    pageSize:     z.enum(['LETTER', 'A4']).optional().default('LETTER'),
    orientation:  z.enum(['PORTRAIT', 'LANDSCAPE']).optional().default('PORTRAIT'),
    marginTop:    z.number().optional().default(60),
    marginBottom: z.number().optional().default(60),
    marginLeft:   z.number().optional().default(60),
    marginRight:  z.number().optional().default(60),

    cover: z.object({
      html:        z.string().optional().default('').describe('HTML for cover text (may use merge params)'),
      imageUrl:    z.string().optional().default('').describe('URL of cover/logo image'),
      condition:   z.string().optional().default('true').describe('"true" = always, or rule expression'),
    }).optional(),

    header: z.object({
      imageUrl:  z.string().optional().default(''),
      condition: z.string().optional().default('true'),
    }).optional(),

    footer: z.object({
      html:      z.string().optional().default(''),
      condition: z.string().optional().default('true'),
    }).optional(),

    bodySections: z.array(z.discriminatedUnion('type', [
      z.object({
        type:    z.literal('TEXT'),
        title:   z.string(),
        content: z.array(z.object({
          title:          z.string().optional(),
          html:           z.string().describe('HTML string; use [Param] for merge fields'),
          condition:      z.string().nullable().optional().describe('"true", "false", or rule expression'),
          pageBreakAfter: z.boolean().optional(),
        })),
      }),
      z.object({
        type:     z.literal('IMAGE'),
        title:    z.string(),
        imageUrl: z.string().optional().default(''),
        condition: z.string().nullable().optional(),
      }),
      z.object({
        type:  z.literal('TABLE'),
        title: z.string(),
        tableConfig: z.object({
          tableType:          z.enum(['PRODUCTS_TABLE', 'BUNDLE_TABLE', 'TOTAL_PRICE_TABLE']).optional().default('PRODUCTS_TABLE'),
          tableSectionTitle:  z.string().optional().default('Pricing Table'),
          activeColumns:      z.array(z.string()).optional().describe('Column labels to show, e.g. ["ITEM_NAME","SKU","QUANTITY","NET_PRICE"]'),
          columnNames:        z.record(z.string()).optional().describe('Custom header labels by column label key'),
          showTotalListPrice: z.boolean().optional().default(true),
          showDiscount:       z.boolean().optional().default(true),
          showTotalNetPrice:  z.boolean().optional().default(true),
          condition:          z.string().optional().default('true'),
        }).optional(),
      }),
      z.object({
        type:        z.literal('SIGNATURE'),
        title:       z.string(),
        signatories: z.array(z.string()).optional().default(['BUYER', 'SELLER']),
      }),
      z.object({
        type:            z.literal('SUBTEMPLATE'),
        title:           z.string(),
        subTemplateGUID: z.string(),
        condition:       z.string().nullable().optional(),
      }),
      z.object({
        type:  z.literal('PAGE_BREAK'),
        title: z.string().optional().default('page-break'),
      }),
    ])).describe('Body sections in order from top to bottom'),
  },

  async ({ name, playbookGUID, versionGUID, pageSize, orientation, marginTop, marginBottom, marginLeft, marginRight, cover, header, footer, bodySections }) => {
    // 1 — Create document
    const raw = await apiMultipart('/outputdoc/createOrUpdate', 'outputDocument', JSON.stringify(createDocPayload(name, playbookGUID, versionGUID)));
    const docGUID = raw.replace(/"/g, '').trim();

    // 2 — Fetch skeleton
    const state = await apiGet(`/outputData/edit?guid=${docGUID}&versionGUID=${versionGUID}`);

    // 3 — Page settings (applied at save time via buildSavePayload overrides)
    state._pageSize        = pageSize     || 'LETTER';
    state._pageOrientation = orientation  || 'PORTRAIT';
    state.marginTop        = marginTop    ?? 96;
    state.marginBottom     = marginBottom ?? 96;
    state.marginLeft       = marginLeft   ?? 96;
    state.marginRight      = marginRight  ?? 96;

    // 4 — Cover page
    if (cover) {
      const coverSec = getSection(state, 'Cover_page');
      const coverText = coverSec?.parts.find(p => p.guid === 'cover-text');
      if (coverText?.content?.[0]) {
        coverText.content[0].desc      = cover.html || '';
        coverText.content[0].condition = cover.condition ?? null;
        coverText.selectedGuid         = coverText.content[0].guid;
      }
      const coverImg = coverSec?.parts.find(p => p.guid === 'cover-image');
      if (coverImg?.content?.[0]) {
        coverImg.content[0].url        = cover.imageUrl || '';
        coverImg.selectedGuid          = coverImg.content[0].guid;
      }
    }

    // 5 — Header / Footer
    const hfSec = getSection(state, 'Header_and_footer');
    if (header) {
      const hp = hfSec?.parts.find(p => p.guid === 'header');
      if (hp?.content?.[0]) {
        hp.content[0].url       = header.imageUrl || '';
        hp.content[0].condition = header.condition ?? null;
        hp.selectedGuid         = hp.content[0].guid;
      }
    }
    if (footer) {
      const fp = hfSec?.parts.find(p => p.guid === 'footer');
      if (fp?.content?.[0]) {
        fp.content[0].desc      = footer.html || '';
        fp.content[0].condition = footer.condition ?? null;
        fp.selectedGuid         = fp.content[0].guid;
      }
    }

    // 6 — Body sections
    const body = getSection(state, 'Body');
    for (const sec of (bodySections || [])) {
      if (sec.type === 'PAGE_BREAK') {
        const last = body.parts[body.parts.length - 1];
        const lastContent = last?.content;
        if (lastContent?.length) lastContent[lastContent.length - 1].pageBreakAfter = true;
        continue;
      }
      switch (sec.type) {
        case 'TEXT':
          body.parts.push(makeTextPart(sec.title, sec.content || [{ title: sec.title, html: '' }]));
          break;
        case 'IMAGE':
          body.parts.push(makeImagePart(sec.title, sec.imageUrl, sec.condition));
          break;
        case 'TABLE':
          body.parts.push(makeTablePart(sec.title, sec.tableConfig || {}));
          break;
        case 'SIGNATURE':
          body.parts.push(makeSignaturePart(sec.title, { signatories: sec.signatories }));
          break;
        case 'SUBTEMPLATE':
          body.parts.push(makeSubTemplatePart(sec.title, sec.subTemplateGUID, sec.condition));
          break;
      }
    }

    // 7 — Save
    const savePayload = buildSavePayload(state, versionGUID, name);
    savePayload.pageSize        = state._pageSize        || 'LETTER';
    savePayload.pageOrientation = state._pageOrientation || 'PORTRAIT';
    await apiGzipPost('/outputData/save', savePayload);

    const url = `${BASE_URL}/#/docComposer?versionGUID=${versionGUID}&docName=${encodeURIComponent(name)}&docGUID=${docGUID}`;
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          success:      true,
          docGUID,
          name,
          sections:     (bodySections || []).filter(s => s.type !== 'PAGE_BREAK').length,
          playbookGUID,
          versionGUID,
          url,
        }, null, 2),
      }],
    };
  }
);

// ── Start ─────────────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('dealhub-output-doc-mcp v1.0.0 ready');
}

main().catch(e => { console.error(e); process.exit(1); });
