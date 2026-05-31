#!/usr/bin/env node
/**
 * Analyzes captured_requests.json and prints a structured summary
 * of DealHub API endpoints, request shapes, and response shapes.
 * Run AFTER capture.js has collected traffic.
 */

const fs = require('fs');

const INPUT = process.argv[2] || 'captured_requests.json';
if (!fs.existsSync(INPUT)) {
  console.error(`File not found: ${INPUT}`);
  process.exit(1);
}

const requests = JSON.parse(fs.readFileSync(INPUT, 'utf8'));
console.log(`Loaded ${requests.length} captured requests from ${INPUT}\n`);

// ── Group by method + path (strip IDs and query strings) ──────────────────
function normalize(url) {
  try {
    const u = new URL(url);
    // Replace UUID-like and numeric segments with placeholders
    const path = u.pathname
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ':id')
      .replace(/\/\d+\//g, '/:n/')
      .replace(/\/\d+$/, '/:n');
    return { host: u.host, path, query: u.search };
  } catch {
    return { host: '', path: url, query: '' };
  }
}

const endpoints = new Map(); // "METHOD path" → [{entry}]

for (const entry of requests) {
  const { host, path } = normalize(entry.url);
  const key = `${entry.method} ${host}${path}`;
  if (!endpoints.has(key)) endpoints.set(key, []);
  endpoints.get(key).push(entry);
}

// ── Print summary ──────────────────────────────────────────────────────────
const sorted = [...endpoints.entries()].sort((a, b) => b[1].length - a[1].length);

console.log('=== API ENDPOINTS (sorted by frequency) ===\n');
for (const [key, entries] of sorted) {
  const sample = entries[0];
  console.log(`${key}  (×${entries.length})`);
  if (sample.requestBody && typeof sample.requestBody === 'object') {
    console.log('  Request shape:', JSON.stringify(sample.requestBody, null, 2).split('\n').slice(0, 8).join('\n  '));
  }
  if (sample.responseBody && typeof sample.responseBody === 'object') {
    const keys = Array.isArray(sample.responseBody)
      ? `Array[${sample.responseBody.length}] of ${typeof sample.responseBody[0]}`
      : Object.keys(sample.responseBody).slice(0, 10).join(', ');
    console.log('  Response keys:', keys);
  }
  console.log();
}

// ── Document-related endpoints heuristic ──────────────────────────────────
console.log('=== LIKELY DOCUMENT ENDPOINTS ===\n');
const docKeywords = ['document', 'output', 'template', 'element', 'condition', 'section', 'save', 'publish'];
for (const [key, entries] of sorted) {
  const lower = key.toLowerCase();
  if (docKeywords.some(k => lower.includes(k))) {
    const e = entries[0];
    console.log(key);
    if (e.requestBody)  console.log('  body:', JSON.stringify(e.requestBody).slice(0, 200));
    if (e.responseBody) console.log('  resp:', JSON.stringify(e.responseBody).slice(0, 200));
    console.log();
  }
}

// ── Export condensed endpoint map for MCP builder ─────────────────────────
const summary = sorted.map(([key, entries]) => {
  const e = entries[0];
  return {
    endpoint: key,
    count: entries.length,
    sampleRequest: e.requestBody ?? null,
    sampleResponse: typeof e.responseBody === 'object' ? e.responseBody : null,
    status: e.status,
    url: e.url,
  };
});

fs.writeFileSync('endpoint_summary.json', JSON.stringify(summary, null, 2));
console.log('Full summary written to endpoint_summary.json');
