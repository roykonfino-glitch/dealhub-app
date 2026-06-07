#!/usr/bin/env node
/**
 * DealHub Knowledge MCP Server
 *
 * Exposes the DealHub AI tools guide and all reference docs as MCP resources,
 * plus a search tool for querying across them.
 *
 * Resources:
 *   dealhub://tools-guide              — when to use Extension vs Full Claude Toolkit
 *   dealhub://concepts                 — versions, playbooks, groups, questions, rules
 *   dealhub://formula-rules            — four expression contexts, syntax, gotchas
 *   dealhub://api-patterns             — known endpoints, request/response shapes
 *   dealhub://advanced-apis            — approvals, SVs, external queries, subscriptions
 *   dealhub://playbook-design          — BSDM, baseline structure, brownfield discipline
 *   dealhub://skills-index             — what each build skill does, when to use it
 *   dealhub://tool-reference           — all 16 Claude extension tools
 *   dealhub://extension-architecture   — how extension, iframe, background.js connect
 *
 * Tools:
 *   search_knowledge(query)            — full-text search across all docs
 *   get_decision(task)                 — returns Extension vs Full Claude for a given task
 */

const { McpServer }            = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z }  = require('zod');
const fs     = require('fs');
const path   = require('path');

// ── Paths ─────────────────────────────────────────────────────────────────────

const REFS_DIR       = path.join(__dirname, '../dealhub-web/references');
const COMMANDS_DIR   = path.join(__dirname, '../dealhub-web/.claude/commands');

const DOCS = [
  {
    uri:   'dealhub://tools-guide',
    name:  'DealHub AI Tools Guide — When to Use What',
    file:  path.join(COMMANDS_DIR, 'tools-guide.md'),
    desc:  'Decision guide: Extension vs Full Claude Toolkit. Task reference table, capability matrix, key gotchas.',
  },
  {
    uri:   'dealhub://concepts',
    name:  'DealHub Core Concepts',
    file:  path.join(REFS_DIR, 'dealhub-concepts.md'),
    desc:  'Versions, playbooks, groups, questions, rules syntax, numeric/text-list value formats, save gotchas.',
  },
  {
    uri:   'dealhub://formula-rules',
    name:  'Formula & Rules Guide',
    file:  path.join(REFS_DIR, 'formula-rules-guide.md'),
    desc:  'Four expression contexts, quoting rules, dateAttributeValueType, no-nesting constraint, function list.',
  },
  {
    uri:   'dealhub://api-patterns',
    name:  'DealHub API Patterns',
    file:  path.join(REFS_DIR, 'api-patterns.md'),
    desc:  'Known endpoints, auth (CSRF + cookies), request/response shapes, 401/400 handling.',
  },
  {
    uri:   'dealhub://advanced-apis',
    name:  'DealHub Advanced APIs',
    file:  path.join(REFS_DIR, 'advanced-apis.md'),
    desc:  'Approval workflows, submit validations, external queries, volume discounts, subscriptions, output docs.',
  },
  {
    uri:   'dealhub://playbook-design',
    name:  'Playbook Design Principles',
    file:  path.join(REFS_DIR, 'playbook-design-principles.md'),
    desc:  'BSDM framework, baseline 4-group structure, brownfield discipline, two-pass save, product selection.',
  },
  {
    uri:   'dealhub://skills-index',
    name:  'Skills Index',
    file:  path.join(REFS_DIR, 'skills-index.md'),
    desc:  'All 14 build skills — what they do, when to use them, key constraints and gotchas.',
  },
  {
    uri:   'dealhub://tool-reference',
    name:  'Extension Tool Reference',
    file:  path.join(REFS_DIR, 'tool-reference.md'),
    desc:  'All 16 Claude extension tools — descriptions, inputs, behaviour rules.',
  },
  {
    uri:   'dealhub://extension-architecture',
    name:  'Extension Architecture',
    file:  path.join(REFS_DIR, 'extension-architecture.md'),
    desc:  'How the Chrome extension, iframe, sidepanel, and background.js connect.',
  },
];

function readDoc(file) {
  try { return fs.readFileSync(file, 'utf8'); }
  catch { return `(file not found: ${file})`; }
}

// ── Server ────────────────────────────────────────────────────────────────────

const server = new McpServer({
  name:    'dealhub-knowledge',
  version: '1.0.0',
});

// ── Resources ─────────────────────────────────────────────────────────────────

server.resource(
  'docs-list',
  'dealhub://docs',
  { name: 'All DealHub Knowledge Docs', description: 'List of all available reference documents.' },
  async () => ({
    contents: [{
      uri:      'dealhub://docs',
      mimeType: 'text/plain',
      text:     DOCS.map(d => `${d.uri}\n  ${d.name}\n  ${d.desc}`).join('\n\n'),
    }],
  })
);

for (const doc of DOCS) {
  server.resource(
    doc.uri.replace('dealhub://', ''),
    doc.uri,
    { name: doc.name, description: doc.desc },
    async () => ({
      contents: [{
        uri:      doc.uri,
        mimeType: 'text/markdown',
        text:     readDoc(doc.file),
      }],
    })
  );
}

// ── Tools ─────────────────────────────────────────────────────────────────────

server.tool(
  'search_knowledge',
  'Full-text search across all DealHub reference docs. Returns matching excerpts with source.',
  { query: z.string().describe('Search term or phrase') },
  async ({ query }) => {
    const q = query.toLowerCase();
    const results = [];

    for (const doc of DOCS) {
      const text = readDoc(doc.file);
      const lines = text.split('\n');
      const matches = [];

      for (let i = 0; i < lines.length; i++) {
        if (lines[i].toLowerCase().includes(q)) {
          const start = Math.max(0, i - 1);
          const end   = Math.min(lines.length - 1, i + 2);
          matches.push(lines.slice(start, end + 1).join('\n'));
        }
      }

      if (matches.length > 0) {
        results.push(`## ${doc.name} (${doc.uri})\n\n${matches.slice(0, 5).join('\n---\n')}`);
      }
    }

    if (results.length === 0) {
      return { content: [{ type: 'text', text: `No results found for "${query}".` }] };
    }

    return {
      content: [{
        type: 'text',
        text: `Found in ${results.length} document(s):\n\n${results.join('\n\n')}`,
      }],
    };
  }
);

server.tool(
  'get_decision',
  'Given a DealHub task, returns whether to use the Extension or the Full Claude Toolkit, with reasoning.',
  { task: z.string().describe('Describe what you need to do in DealHub') },
  async ({ task }) => {
    const t = task.toLowerCase();

    // Extension signals
    const extSignals = [
      'rename', 'label', 'question update', 'hide rule', 'hidden rule', 'read-only', 'readonly',
      'presentation rule', 'formula fix', 'add question', 'add a question', 'bulk create',
      'one question', 'single question', 'quick', 'tweak', 'change label', 'fix formula',
    ];
    // Full Claude signals
    const fullSignals = [
      'catalog', 'product', 'pricing rule', 'assignment rule', 'workflow', 'approval',
      'submit validation', 'external query', 'soql', 'hubspot', 'output doc', 'order form',
      'pdf', 'bundle', 'multi-year', 'subscription', 'user clone', 'user management',
      'migration', 'audit', 'impact analysis', 'brownfield', 'xlsx', 'pptx', 'deliverable',
      'picker', 'filter framework', 'volume discount',
    ];

    const extScore  = extSignals.filter(s => t.includes(s)).length;
    const fullScore = fullSignals.filter(s => t.includes(s)).length;

    const guide = readDoc(path.join(COMMANDS_DIR, 'tools-guide.md'));

    let recommendation;
    if (fullScore > 0) {
      recommendation = `**Use the Full Claude Toolkit.**\nDetected: ${fullSignals.filter(s => t.includes(s)).join(', ')}\n\nThe Full Claude Toolkit covers all surfaces beyond the playbook (catalog, workflows, output docs, audits, etc.). The Extension is playbook-only.`;
    } else if (extScore > 0) {
      recommendation = `**Use the Extension.**\nDetected: ${extSignals.filter(s => t.includes(s)).join(', ')}\n\nThis is a surgical playbook edit — the Extension handles it in seconds with zero setup.`;
    } else {
      recommendation = `**Unclear from task description.** Quick rule:\n- Change limited to playbook questions/groups/rules → Extension\n- Touches catalog, pricing, workflows, output docs, users, or needs IA → Full Claude Toolkit`;
    }

    return {
      content: [{
        type: 'text',
        text: `## Decision for: "${task}"\n\n${recommendation}\n\n---\n\nFull guide: read the \`dealhub://tools-guide\` resource for the complete task reference table.`,
      }],
    };
  }
);

// ── Start ─────────────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('DealHub Knowledge MCP server running (stdio)');
}

main().catch(err => { console.error(err); process.exit(1); });
