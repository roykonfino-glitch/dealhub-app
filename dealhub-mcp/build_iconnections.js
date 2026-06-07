#!/usr/bin/env node
/**
 * Builds the "claude" document with the iConnections Q-10068 order form content.
 * Run once: node build_iconnections.js
 */

const { request: pwRequest } = require('playwright');
const zlib = require('zlib');
const fs   = require('fs');
const path = require('path');

const BASE_URL     = 'https://poc.dealhub.io';
const SESSION_FILE = path.join(__dirname, 'session_state.json');
const DOC_GUID     = 'PvCf1VeBrU3lkNIa';
const VERSION_GUID = '238a077587a3EAcC';

// ── Helpers ───────────────────────────────────────────────────────────────────

function dhId() { return Date.now().toString() + Math.floor(Math.random() * 1000); }

function gzip(obj) {
  return new Promise((ok, fail) =>
    zlib.gzip(Buffer.from(JSON.stringify(obj), 'utf8'), (e, b) => e ? fail(e) : ok(b))
  );
}

// ── Content builders ──────────────────────────────────────────────────────────

function textPart(title, items) {
  const baseId = Date.now();
  const content = items.map((ci, i) => ({
    guid:             (baseId + i + 1).toString(),
    title:            ci.title || title,
    desc:             ci.html || '',
    url:              '',
    condition:        ci.condition ?? null,
    pageBreakAfter:   ci.pageBreakAfter || false,
    footerHR:         ci.footerHR ?? false,
    lockedForChanges: false,
  }));
  return {
    guid:              dhId(),
    selectedGuid:      content[0].guid,
    template:          'docComposerTextSection.html',
    expanded:          true,
    shown:             true,
    title,
    type:              'TEXT',
    includePageNumber: false,
    content,
  };
}

const ALL_COLS = [
  { label: 'ORDINAL',               displayName: 'Ordinal',            headerAlign: 'LEFT', bodyAlign: 'RIGHT' },
  { label: 'GROUP',                 displayName: 'Group',              headerAlign: 'LEFT', bodyAlign: 'LEFT'  },
  { label: 'ITEM_NAME',             displayName: 'Item Name',          headerAlign: 'LEFT', bodyAlign: 'LEFT'  },
  { label: 'DESCRIPTION',           displayName: 'Description',        headerAlign: 'LEFT', bodyAlign: 'LEFT'  },
  { label: 'SKU',                   displayName: 'SKU',                headerAlign: 'LEFT', bodyAlign: 'LEFT'  },
  { label: 'TAG',                   displayName: 'Primary Tag',        headerAlign: 'LEFT', bodyAlign: 'LEFT'  },
  { label: 'BASE_PRICE',            displayName: 'List Price/Unit',    headerAlign: 'LEFT', bodyAlign: 'RIGHT' },
  { label: 'DURATION',              displayName: 'Duration',           headerAlign: 'LEFT', bodyAlign: 'RIGHT' },
  { label: 'QUANTITY',              displayName: 'Quantity',           headerAlign: 'LEFT', bodyAlign: 'RIGHT' },
  { label: 'IS_RENEWABLE',          displayName: 'Is Renewable',       headerAlign: 'LEFT', bodyAlign: 'LEFT'  },
  { label: 'START_DATE',            displayName: 'Start Date',         headerAlign: 'LEFT', bodyAlign: 'LEFT'  },
  { label: 'END_DATE',              displayName: 'End Date',           headerAlign: 'LEFT', bodyAlign: 'LEFT'  },
  { label: 'NUMBER',                displayName: 'Number',             headerAlign: 'LEFT', bodyAlign: 'RIGHT' },
  { label: 'MULTIPLY_ALL_FACTORS',  displayName: 'Total Quantity',     headerAlign: 'LEFT', bodyAlign: 'RIGHT' },
  { label: 'LIST_PRICE',            displayName: 'List Price',         headerAlign: 'LEFT', bodyAlign: 'RIGHT' },
  { label: 'POSITIVE_LIST_PRICE',   displayName: 'Positive List Price',headerAlign: 'LEFT', bodyAlign: 'RIGHT' },
  { label: 'NEGATIVE_LIST_PRICE',   displayName: 'Negative List Price',headerAlign: 'LEFT', bodyAlign: 'RIGHT' },
  { label: 'PROMOTION_DISCOUNT',    displayName: 'Promotions',         headerAlign: 'LEFT', bodyAlign: 'RIGHT' },
  { label: 'PROMOTION_DISCOUNT_PRCT',displayName: 'Promotions %',      headerAlign: 'LEFT', bodyAlign: 'RIGHT' },
  { label: 'SPECIAL_DISCOUNT',      displayName: 'Special Discount',   headerAlign: 'LEFT', bodyAlign: 'RIGHT' },
  { label: 'SPECIAL_DISCOUNT_PRCT', displayName: 'Special Disc %',     headerAlign: 'LEFT', bodyAlign: 'RIGHT' },
  { label: 'USER_DISCOUNT',         displayName: 'Sales Discount',     headerAlign: 'LEFT', bodyAlign: 'RIGHT' },
  { label: 'USER_DISCOUNT_PRCT',    displayName: 'Sales Disc %',       headerAlign: 'LEFT', bodyAlign: 'RIGHT' },
  { label: 'DISCOUNT_PRCT',         displayName: 'Discount %',         headerAlign: 'LEFT', bodyAlign: 'RIGHT' },
  { label: 'DISCOUNT_$',            displayName: 'Discount $',         headerAlign: 'LEFT', bodyAlign: 'RIGHT' },
  { label: 'NET_PRICE',             displayName: 'Total',              headerAlign: 'LEFT', bodyAlign: 'RIGHT' },
  { label: 'NET_PRICE_PER_UNIT',    displayName: 'Net Price / Unit',   headerAlign: 'LEFT', bodyAlign: 'RIGHT' },
  { label: 'MSRP',                  displayName: 'MSRP',               headerAlign: 'LEFT', bodyAlign: 'RIGHT' },
  { label: 'MSRP_DISCOUNT',         displayName: 'MSRP Discount',      headerAlign: 'LEFT', bodyAlign: 'RIGHT' },
].map(c => ({
  active: false, cellWidth: 0,
  displayName: c.displayName, displayFirstName: null, displaySecondName: null,
  label: c.label, ordinal: 0, sortable: true,
  groupColumnType: 'EMPTY', groupColumnFreeText: '', groupColumnFormula: '',
  displayFirstData: null, displaySecondData: null,
  presentationRule: 'false', cellDataWidth: 0, cellHeight: 0, maxCellHeight: 0,
  headerAlign: c.headerAlign, bodyAlign: c.bodyAlign,
  totalsRowLabel: 'N/A', showInTotalsRow: false, enableSummarizeInTotalsRow: false,
}));

function tablePart(title, activeLabels, nameOverrides = {}) {
  const id     = dhId();
  const partId = (Date.now() + 1).toString();
  const cols   = ALL_COLS.map(c => ({
    ...c,
    active:      activeLabels.includes(c.label),
    displayName: nameOverrides[c.label] || c.displayName,
  }));
  return {
    guid:              id,
    selectedGuid:      '',
    template:          'docComposerTableSection.html',
    expanded:          true,
    shown:             true,
    title,
    type:              'TABLE',
    tableType:         'PRODUCTS_TABLE',
    includePageNumber: false,
    tableParts: [{
      guid:                   partId,
      title:                  'Pricing Table',
      condition:              'true',
      usePresentationRule:    false,
      subject:                '',
      showTotalListPrice:     false,
      totalListPriceName:     'Total List Price',
      showDiscount:           false,
      discountName:           'Discount',
      discountType:           'DISCOUNT_PRCT',
      showTotalNegativePrice: false,
      totalNegativePriceName: 'Total Negative Price',
      showTotalNetPrice:      true,
      totalNetPriceName:      'Total Net Price',
      showTablePerType:       false,
      content:                cols,
    }],
  };
}

// ── iConnections HTML content ─────────────────────────────────────────────────

const FOOTER_HTML = `<p style="font-size:9px;color:#666;text-align:center;">
This document is confidential and is intended solely for the use of the individual or entity to whom it is addressed.
The information contained in this document is confidential, privileged, and only for the information of the intended
recipient and may not be used, published, or redistributed without the prior written consent of iConnections.
</p>`;

const ORDER_FORM_HTML = `
<table style="width:800px;border-collapse:collapse;font-family:Arial,sans-serif;font-size:11px;">
  <tbody>
    <tr>
      <td style="background:#4a4a4a;color:#fff;font-weight:bold;padding:6px 10px;width:35%;">Client Name</td>
      <td style="padding:6px 10px;border:1px solid #ddd;">%OPPORTUNITY_ACCOUNT%</td>
    </tr>
    <tr>
      <td style="background:#4a4a4a;color:#fff;font-weight:bold;padding:6px 10px;">Contract Type</td>
      <td style="padding:6px 10px;border:1px solid #ddd;">%GQ.Opp_Type%</td>
    </tr>
    <tr>
      <td style="background:#4a4a4a;color:#fff;font-weight:bold;padding:6px 10px;">Contract Start Date</td>
      <td style="padding:6px 10px;border:1px solid #ddd;">%GQ.Start_Date%</td>
    </tr>
    <tr>
      <td style="background:#4a4a4a;color:#fff;font-weight:bold;padding:6px 10px;">Contract End Date</td>
      <td style="padding:6px 10px;border:1px solid #ddd;">%GQ.End_Date%</td>
    </tr>
    <tr>
      <td style="background:#4a4a4a;color:#fff;font-weight:bold;padding:6px 10px;">Duration</td>
      <td style="padding:6px 10px;border:1px solid #ddd;">%GQ.Duration%</td>
    </tr>
    <tr>
      <td style="background:#4a4a4a;color:#fff;font-weight:bold;padding:6px 10px;">Region</td>
      <td style="padding:6px 10px;border:1px solid #ddd;">%GQ.Region%</td>
    </tr>
    <tr>
      <td style="background:#4a4a4a;color:#fff;font-weight:bold;padding:6px 10px;">Prepared By</td>
      <td style="padding:6px 10px;border:1px solid #ddd;">%USER_FULLNAME%</td>
    </tr>
    <tr>
      <td style="background:#4a4a4a;color:#fff;font-weight:bold;padding:6px 10px;">Sales Manager</td>
      <td style="padding:6px 10px;border:1px solid #ddd;">%OWNER_FULLNAME%</td>
    </tr>
    <tr>
      <td style="background:#4a4a4a;color:#fff;font-weight:bold;padding:6px 10px;">Billing Name</td>
      <td style="padding:6px 10px;border:1px solid #ddd;">%Document.Billing_Name%</td>
    </tr>
    <tr>
      <td style="background:#4a4a4a;color:#fff;font-weight:bold;padding:6px 10px;">Billing Email</td>
      <td style="padding:6px 10px;border:1px solid #ddd;">%Document.Billing_Email%</td>
    </tr>
  </tbody>
</table>`;

const WHATS_INCLUDED_HTML = `
<p style="font-family:Arial,sans-serif;font-size:18px;font-weight:bold;color:#5b2d8e;margin-bottom:4px;">
  iConnections Established
</p>
<p style="font-family:Arial,sans-serif;font-size:13px;color:#333;margin-bottom:12px;">
  What&rsquo;s Included
</p>
<table style="width:800px;border-collapse:collapse;font-family:Arial,sans-serif;font-size:11px;">
  <thead>
    <tr>
      <th style="background:#5b2d8e;color:#fff;padding:8px 12px;text-align:left;width:40%;">Category</th>
      <th style="background:#5b2d8e;color:#fff;padding:8px 12px;text-align:left;">Value</th>
    </tr>
  </thead>
  <tbody>
    <tr style="background:#f3eefe;">
      <td style="padding:7px 12px;border-bottom:1px solid #ddd;font-weight:bold;">Meetings</td>
      <td style="padding:7px 12px;border-bottom:1px solid #ddd;">Access to all iConnections meetings and events</td>
    </tr>
    <tr>
      <td style="padding:7px 12px;border-bottom:1px solid #ddd;font-weight:bold;">Platform Features</td>
      <td style="padding:7px 12px;border-bottom:1px solid #ddd;">Full platform access including analytics and reporting</td>
    </tr>
    <tr style="background:#f3eefe;">
      <td style="padding:7px 12px;font-weight:bold;">Event Features</td>
      <td style="padding:7px 12px;">Priority registration and networking tools</td>
    </tr>
  </tbody>
</table>`;

// ── Main ──────────────────────────────────────────────────────────────────────

(async () => {
  const ctx = await pwRequest.newContext({
    baseURL: BASE_URL,
    storageState: JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8')),
    extraHTTPHeaders: {
      'Accept':   'application/json',
      'Origin':   BASE_URL,
      'Referer':  BASE_URL + '/',
    },
  });

  console.log('Fetching current document...');
  const getRes = await ctx.get(`/outputData/edit?guid=${DOC_GUID}&versionGUID=${VERSION_GUID}`);
  if (!getRes.ok()) throw new Error(`GET failed: ${getRes.status()}`);
  const state = await getRes.json();

  const outputData = typeof state.outputData === 'string'
    ? JSON.parse(state.outputData)
    : state.outputData;

  // ── Update footer ──────────────────────────────────────────────────────────
  const hf = outputData.sections.find(s => s.title === 'Header_and_footer');
  const footer = hf?.parts.find(p => p.guid === 'footer');
  if (footer && footer.content[0]) {
    footer.content[0].desc = FOOTER_HTML;
    console.log('Footer updated.');
  }

  // ── Replace body with 3 sections ──────────────────────────────────────────
  const body = outputData.sections.find(s => s.title === 'Body');
  body.parts = [
    textPart('Order Form Details', [{
      title: 'Order Form Details',
      html:  ORDER_FORM_HTML,
    }]),
    textPart("What's Included", [{
      title: "What's Included",
      html:  WHATS_INCLUDED_HTML,
    }]),
    tablePart('Global Alts Miami 2027', ['ITEM_NAME', 'QUANTITY', 'NET_PRICE'], {
      NET_PRICE: 'Total',
    }),
  ];
  console.log('Body sections built (Order Form, Whats Included, Pricing Table).');

  // ── Build correct save payload ─────────────────────────────────────────────
  const savePayload = {
    versionGUID:              VERSION_GUID,
    guid:                     state.outputDocGUID,
    pageSize:                 state.selectedPageSize        || 'LETTER',
    pageOrientation:          state.selectedPageOrientation || 'PORTRAIT',
    pages:                    outputData,
    defaultTablePart:         null,
    isRTL:                    state.isRTL            ?? false,
    showOnce:                 state.showOnce         ?? false,
    wrapTablesWithLines:      state.wrapTablesWithLines ?? true,
    marginTop:                60,
    marginBottom:             60,
    marginLeft:               60,
    marginRight:              60,
    coverPagePresentationRule: state.coverPagePresentationRule ?? 'true',
    changeLogRecords: [{
      date:                    Date.now(),
      username:                'mcp-agent',
      userlogin:               'mcp@dealhub.io',
      impersonatorUserName:    null,
      impersonatorDealhubUser: false,
      dealhubUser:             true,
      action:                  'Modification',
      object:                  'Output Document',
      objectName:              'claude',
      subObject: '', subObjectName: '', attribute: '', attributeName: '', fromValue: '', toValue: '',
    }],
  };

  const buf = await gzip(savePayload);

  console.log('Saving document...');
  const saveRes = await ctx.post('/outputData/save', {
    headers: {
      'Content-Type':     'application/json',
      'Content-Encoding': 'gzip',
    },
    data: buf,
  });

  const saveText = await saveRes.text();
  console.log(`Save → ${saveRes.status()}: ${saveText.slice(0, 300)}`);

  await ctx.dispose();
})().catch(err => { console.error(err); process.exit(1); });
