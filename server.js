import express from 'express';
import crypto from 'crypto';
import dns from 'dns/promises';
import net from 'net';
import { paymentMiddleware, x402ResourceServer } from '@x402/express';
import { HTTPFacilitatorClient } from '@x402/core/server';
import { ExactEvmScheme } from '@x402/evm/exact/server';
import { createFacilitatorConfig } from '@coinbase/x402';
import {
  bazaarResourceServerExtension,
  declareDiscoveryExtension,
  withBazaar
} from '@x402/extensions/bazaar';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { PDFParse } from 'pdf-parse';

const app = express();
app.set('trust proxy', true);
app.use(express.json({ limit: '25mb' }));

const WALLET_ADDRESS = process.env.PAY_TO_ADDRESS || '0x3268C9434D8603957420f04510CA0ff6097A5C64';
const BASE_URL = process.env.BASE_URL || 'https://lotusnetworkapi.com';
const CONTACT_EMAIL = process.env.CONTACT_EMAIL || 'blacklotusfinance.pls@gmail.com';

const REPLICATE_TOKEN = process.env.REPLICATE_API_TOKEN;
const REPLICATE_MODEL = process.env.REPLICATE_MODEL || 'black-forest-labs/flux-schnell';

const CDP_KEY_ID = process.env.CDP_API_KEY_ID;
const CDP_KEY_SECRET = process.env.CDP_API_KEY_SECRET;

const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID;
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
const R2_BUCKET = process.env.R2_BUCKET || 'x402-images';
const RETENTION_DAYS = Number(process.env.IMAGE_RETENTION_DAYS || 30);

const BASE_RPC_URL = process.env.BASE_RPC_URL || 'https://mainnet.base.org';

const PRICE_IMAGE = process.env.PRICE_IMAGE || '0.05';
const PRICE_PDF = process.env.PRICE_PDF || '0.005';
const PRICE_PREFLIGHT = process.env.PRICE_PREFLIGHT || '0.002';
const PRICE_DECISION = process.env.PRICE_DECISION || '0.003';
const PRICE_AUDIT = process.env.PRICE_AUDIT || '0.002';

const PDF_MAX_BYTES = 20 * 1024 * 1024;
const PDF_FETCH_TIMEOUT_MS = 30000;

// Base produces a block roughly every 2 seconds.
const BASE_BLOCK_SECONDS = 2;
const FEE_HISTORY_BLOCKS = 300;      // ~10 minutes of history
const Z_80 = 1.2816;                 // two-sided 80% interval
const MEAN_REVERSION = 0.35;         // pull toward the recent median

// ===========================================================================
// SINGLE SOURCE OF TRUTH FOR ENDPOINTS
//
// The x402 route map, the OpenAPI document, and the Bazaar discovery
// extension are all generated from this array. Adding an endpoint means one
// entry here, not four edits that have to stay in sync. x402scan validates
// the OpenAPI spec against runtime 402 behaviour, so drift breaks the listing.
// ===========================================================================
const ENDPOINTS = [
  {
    method: 'GET',
    path: '/api/v1/generate-image',
    price: PRICE_IMAGE,
    operationId: 'generateImage',
    summary: 'Generate an image from a text prompt',
    tags: ['Media'],
    description:
      'Text-to-image generation powered by FLUX. Send a prompt, get back a 1024x1024 image as ' +
      'base64 JSON or raw bytes, plus a durable direct URL. No API key or account needed.',
    parameters: [
      {
        name: 'prompt', in: 'query', required: true,
        description: 'Text description of the image to generate',
        schema: { type: 'string' },
        example: 'a cyberpunk city skyline at dusk, neon reflections'
      },
      {
        name: 'format', in: 'query', required: false,
        description: 'json returns base64 plus a durable URL; binary returns raw image bytes',
        schema: { type: 'string', enum: ['json', 'binary'], default: 'json' }
      }
    ],
    inputExample: { prompt: 'a cyberpunk city skyline at dusk, neon reflections' },
    inputSchema: {
      properties: {
        prompt: { type: 'string', description: 'Text description of the image to generate' },
        format: { type: 'string', enum: ['json', 'binary'] }
      },
      required: ['prompt']
    },
    outputExample: {
      success: true,
      prompt: 'a cyberpunk city skyline at dusk, neon reflections',
      model: 'black-forest-labs/flux-schnell',
      mimeType: 'image/webp',
      image: '<base64-encoded image bytes>',
      absoluteUrl: `${BASE_URL}/api/v1/image/9f2c4a1e7b3d5f8091a2b3c4d5e6f708`
    },
    outputSchema: {
      properties: {
        success: { type: 'boolean' },
        prompt: { type: 'string' },
        model: { type: 'string' },
        mimeType: { type: 'string' },
        image: { type: 'string', description: 'Base64-encoded image' },
        absoluteUrl: { type: 'string' },
        downloadUrl: { type: 'string' },
        retentionDays: { type: 'number' }
      }
    }
  },
  {
    method: 'POST',
    path: '/api/v1/pdf-to-markdown',
    price: PRICE_PDF,
    operationId: 'pdfToMarkdown',
    summary: 'Convert a PDF into clean Markdown text',
    tags: ['Data'],
    description:
      'Extracts text from a PDF and returns clean Markdown: unwrapped paragraphs, detected ' +
      'headings and bullet lists, no page furniture. Accepts a public PDF URL or base64 bytes. ' +
      'Built for agents that need to read documents they cannot parse natively.',
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              url: { type: 'string', description: 'Public URL of a PDF to fetch and convert' },
              pdf: { type: 'string', description: 'Base64-encoded PDF bytes (alternative to url)' },
              pageMarkers: { type: 'boolean', default: false }
            }
          },
          example: { url: 'https://example.com/whitepaper.pdf' }
        }
      }
    },
    inputExample: { url: 'https://example.com/whitepaper.pdf' },
    inputSchema: {
      properties: {
        url: { type: 'string' },
        pdf: { type: 'string' },
        pageMarkers: { type: 'boolean' }
      }
    },
    outputExample: {
      success: true, pages: 12, characters: 18432,
      title: 'Quarterly Report',
      markdown: '# Quarterly Report\n\nRevenue grew 14% year over year...'
    },
    outputSchema: {
      properties: {
        success: { type: 'boolean' },
        pages: { type: 'number' },
        characters: { type: 'number' },
        title: { type: 'string' },
        markdown: { type: 'string' }
      }
    }
  },
  {
    method: 'GET',
    path: '/api/v1/gas/preflight',
    price: PRICE_PREFLIGHT,
    operationId: 'gasPreflight',
    summary: 'Current Base gas conditions with a calibrated forecast range',
    tags: ['Data'],
    description:
      'Read-only Base L2 gas conditions computed directly from chain data: current base fee, ' +
      'recent percentiles, realised volatility, congestion state, and an 80% forecast range for ' +
      'a chosen horizon. This is supporting context for timing a transaction, not a trade ' +
      'instruction. Every figure is reproducible from public Base RPC data.',
    parameters: [
      {
        name: 'horizonMinutes', in: 'query', required: false,
        description: 'Forecast horizon in minutes (1-60, default 5)',
        schema: { type: 'integer', minimum: 1, maximum: 60, default: 5 }
      }
    ],
    inputExample: { horizonMinutes: 5 },
    inputSchema: {
      properties: {
        horizonMinutes: { type: 'integer', description: 'Forecast horizon in minutes (1-60)' }
      }
    },
    outputExample: {
      success: true,
      chain: 'base-mainnet',
      block: 24881003,
      observedAt: '2026-07-30T04:12:00.000Z',
      current: { baseFeeGwei: 0.0142, congestion: 'calm', gasUsedRatio: 0.31 },
      recent: { medianGwei: 0.0138, p10Gwei: 0.0119, p90Gwei: 0.0181, volatility: 0.041, blocks: 300 },
      forecast: {
        horizonMinutes: 5, targetBlock: 24881153,
        centerGwei: 0.0139, lowGwei: 0.0106, highGwei: 0.0182,
        interval: 0.8, method: 'mean-reverting log random walk on realised block volatility'
      }
    },
    outputSchema: {
      properties: {
        success: { type: 'boolean' },
        chain: { type: 'string' },
        block: { type: 'number' },
        observedAt: { type: 'string' },
        current: { type: 'object', description: 'baseFeeGwei, congestion, gasUsedRatio' },
        recent: { type: 'object', description: 'medianGwei, p10Gwei, p90Gwei, volatility, blocks' },
        forecast: { type: 'object', description: 'centerGwei, lowGwei, highGwei, targetBlock, interval' }
      }
    }
  },
  {
    method: 'POST',
    path: '/api/v1/gas/decision',
    price: PRICE_DECISION,
    operationId: 'gasDecision',
    summary: 'Journal a gas-timing decision and receive an auditable decision_id',
    tags: ['Data'],
    description:
      'Records an agent decision (execute now, or wait) against a fresh forecast snapshot and ' +
      'returns a decision_id plus the block at which the outcome becomes checkable. Nothing is ' +
      'predicted here beyond the snapshot: this is a tamper-evident journal entry so the agent ' +
      'can later prove what it knew and what it chose.',
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              stance: { type: 'string', enum: ['execute', 'wait'], description: 'The agent decision being recorded' },
              horizonMinutes: { type: 'integer', minimum: 1, maximum: 60, default: 5 },
              maxFeeGwei: { type: 'number', description: 'Optional ceiling the agent was willing to pay' },
              note: { type: 'string', description: 'Optional free-text rationale, max 500 chars' }
            },
            required: ['stance']
          },
          example: { stance: 'wait', horizonMinutes: 15, maxFeeGwei: 0.012 }
        }
      }
    },
    inputExample: { stance: 'wait', horizonMinutes: 15, maxFeeGwei: 0.012 },
    inputSchema: {
      properties: {
        stance: { type: 'string', enum: ['execute', 'wait'] },
        horizonMinutes: { type: 'integer' },
        maxFeeGwei: { type: 'number' },
        note: { type: 'string' }
      },
      required: ['stance']
    },
    outputExample: {
      success: true,
      decisionId: '7c1f9a2b4d6e8f0a1b2c3d4e5f607182',
      stance: 'wait',
      recordedAt: '2026-07-30T04:12:00.000Z',
      auditableAt: '2026-07-30T04:27:00.000Z',
      targetBlock: 24881453,
      snapshot: { baseFeeGwei: 0.0142, lowGwei: 0.0106, highGwei: 0.0182 },
      auditUrl: `${BASE_URL}/api/v1/gas/audit/7c1f9a2b4d6e8f0a1b2c3d4e5f607182`
    },
    outputSchema: {
      properties: {
        success: { type: 'boolean' },
        decisionId: { type: 'string' },
        stance: { type: 'string' },
        recordedAt: { type: 'string' },
        auditableAt: { type: 'string' },
        targetBlock: { type: 'number' },
        snapshot: { type: 'object' },
        auditUrl: { type: 'string' }
      }
    }
  },
  {
    method: 'GET',
    path: '/api/v1/gas/audit/{decisionId}',
    routePath: '/api/v1/gas/audit/:decisionId',
    price: PRICE_AUDIT,
    operationId: 'gasAudit',
    summary: 'Verify a journalled decision against what gas actually did',
    tags: ['Data'],
    description:
      'Resolves a decision_id against on-chain reality: what the base fee actually was at the ' +
      'target block, whether the forecast range contained it, and whether the recorded stance ' +
      'turned out cheaper than the alternative. Returns pending if the target block has not ' +
      'been reached yet. This is the verification half of the loop.',
    parameters: [
      {
        name: 'decisionId', in: 'path', required: true,
        description: 'The decision_id returned by /gas/decision',
        schema: { type: 'string' }
      }
    ],
    inputExample: { decisionId: '7c1f9a2b4d6e8f0a1b2c3d4e5f607182' },
    inputSchema: {
      properties: { decisionId: { type: 'string', description: 'The decision_id to audit' } },
      required: ['decisionId']
    },
    outputExample: {
      success: true,
      decisionId: '7c1f9a2b4d6e8f0a1b2c3d4e5f607182',
      status: 'resolved',
      stance: 'wait',
      forecast: { lowGwei: 0.0106, centerGwei: 0.0139, highGwei: 0.0182 },
      actual: { block: 24881453, baseFeeGwei: 0.0121, observedAt: '2026-07-30T04:27:04.000Z' },
      rangeContainedActual: true,
      changePct: -14.8,
      stanceOutcome: 'favourable',
      explanation: 'Base fee fell 14.8% over the horizon, so waiting was cheaper than executing.'
    },
    outputSchema: {
      properties: {
        success: { type: 'boolean' },
        decisionId: { type: 'string' },
        status: { type: 'string', enum: ['resolved', 'pending'] },
        stance: { type: 'string' },
        forecast: { type: 'object' },
        actual: { type: 'object' },
        rangeContainedActual: { type: 'boolean' },
        changePct: { type: 'number' },
        stanceOutcome: { type: 'string', enum: ['favourable', 'unfavourable', 'neutral'] },
        explanation: { type: 'string' }
      }
    }
  }
];

// ---------------------------------------------------------------------------
// Storage. R2 is the durable store for both images and decision records; a
// small in-process LRU sits in front of images.
// ---------------------------------------------------------------------------
const r2Enabled = Boolean(R2_ACCOUNT_ID && R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY);

const r2 = r2Enabled
  ? new S3Client({
      region: 'auto',
      endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY }
    })
  : null;

if (!r2Enabled) {
  console.warn('[storage] R2 not configured — images and decision records will not survive a restart.');
}

const HOT_CACHE_MAX = 30;
const hotCache = new Map();
const decisionMemory = new Map();     // fallback when R2 is absent

function hotSet(id, entry) {
  hotCache.set(id, entry);
  while (hotCache.size > HOT_CACHE_MAX) hotCache.delete(hotCache.keys().next().value);
}

function extFor(mimeType) {
  return (mimeType || 'image/webp').split('/')[1] || 'webp';
}

function slugify(text) {
  return (text || 'image').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'image';
}

async function storeImage({ buffer, mimeType, prompt }) {
  const id = crypto.randomBytes(16).toString('hex');
  const key = `images/${id}.${extFor(mimeType)}`;
  if (r2) {
    await r2.send(new PutObjectCommand({
      Bucket: R2_BUCKET, Key: key, Body: buffer, ContentType: mimeType,
      Metadata: { prompt: encodeURIComponent(prompt).slice(0, 1800) }
    }));
  }
  hotSet(id, { buffer, mimeType, prompt, key });
  return { id, key };
}

async function loadImage(id) {
  const hot = hotCache.get(id);
  if (hot) return hot;
  if (!r2) return null;

  for (const ext of ['webp', 'png', 'jpeg', 'jpg']) {
    try {
      const result = await r2.send(new GetObjectCommand({
        Bucket: R2_BUCKET, Key: `images/${id}.${ext}`
      }));
      const bytes = await result.Body.transformToByteArray();
      const entry = {
        buffer: Buffer.from(bytes),
        mimeType: result.ContentType || `image/${ext}`,
        prompt: result.Metadata && result.Metadata.prompt
          ? decodeURIComponent(result.Metadata.prompt) : 'image',
        key: `images/${id}.${ext}`
      };
      hotSet(id, entry);
      return entry;
    } catch (err) {
      const notFound = err.name === 'NoSuchKey' ||
        (err.$metadata && err.$metadata.httpStatusCode === 404);
      if (!notFound) {
        console.error('[storage] R2 read error:', err.name, err.message);
        return null;
      }
    }
  }
  return null;
}

async function storeDecision(id, record) {
  decisionMemory.set(id, record);
  if (!r2) return;
  await r2.send(new PutObjectCommand({
    Bucket: R2_BUCKET,
    Key: `decisions/${id}.json`,
    Body: Buffer.from(JSON.stringify(record)),
    ContentType: 'application/json'
  }));
}

async function loadDecision(id) {
  if (decisionMemory.has(id)) return decisionMemory.get(id);
  if (!r2) return null;
  try {
    const result = await r2.send(new GetObjectCommand({
      Bucket: R2_BUCKET, Key: `decisions/${id}.json`
    }));
    const text = Buffer.from(await result.Body.transformToByteArray()).toString('utf8');
    const record = JSON.parse(text);
    decisionMemory.set(id, record);
    return record;
  } catch (err) {
    const notFound = err.name === 'NoSuchKey' ||
      (err.$metadata && err.$metadata.httpStatusCode === 404);
    if (!notFound) console.error('[storage] decision read error:', err.name, err.message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// SSRF guard for caller-supplied URLs. Resolve first, refuse anything that
// isn't public unicast. Residual TOCTOU gap: Node re-resolves DNS on fetch,
// so a hostile resolver could answer differently the second time. Closing
// that fully needs a pinned-IP agent; this blocks the realistic cases.
// ---------------------------------------------------------------------------
function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a >= 224) return true;
    return false;
  }
  const lower = ip.toLowerCase();
  if (lower === '::1' || lower === '::') return true;
  if (lower.startsWith('fe80') || lower.startsWith('fc') || lower.startsWith('fd')) return true;
  if (lower.startsWith('::ffff:')) return isPrivateAddress(lower.replace('::ffff:', ''));
  return false;
}

async function assertPublicUrl(rawUrl) {
  let parsed;
  try { parsed = new URL(rawUrl); } catch { throw new Error('Malformed URL'); }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('Only http and https URLs are supported');
  }
  const results = await dns.lookup(parsed.hostname, { all: true });
  if (!results.length) throw new Error('Could not resolve hostname');
  for (const { address } of results) {
    if (isPrivateAddress(address)) throw new Error('URL resolves to a private address and was refused');
  }
  return parsed;
}

async function fetchPdf(rawUrl) {
  await assertPublicUrl(rawUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PDF_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(rawUrl, {
      redirect: 'follow', signal: controller.signal,
      headers: { Accept: 'application/pdf,*/*' }
    });
    if (!res.ok) throw new Error(`Source returned HTTP ${res.status}`);
    await assertPublicUrl(res.url);           // re-check after redirects

    const declared = Number(res.headers.get('content-length') || 0);
    if (declared && declared > PDF_MAX_BYTES) {
      throw new Error(`PDF is ${Math.round(declared / 1048576)} MB; limit is 20 MB`);
    }
    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.length > PDF_MAX_BYTES) throw new Error('PDF exceeds the 20 MB limit');
    return buffer;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// PDF text -> Markdown. Heuristic, not layout-aware: PDFs carry no semantic
// structure, so headings and lists are inferred from line shape. Handles
// ordinary text documents; makes no attempt at multi-column layouts or tables.
// Scanned PDFs have no text layer and come back empty.
// ---------------------------------------------------------------------------
function textToMarkdown(raw) {
  const lines = raw.split(/\r?\n/).map(l => l.replace(/\s+$/, ''));
  const blocks = [];
  let paragraph = [];

  const flush = () => {
    if (!paragraph.length) return;
    let text = '';
    paragraph.forEach((line, i) => {
      if (i === 0) { text = line; return; }
      if (/[-\u2010-\u2015]$/.test(text)) text = text.replace(/[-\u2010-\u2015]$/, '') + line;
      else text += ' ' + line;
    });
    blocks.push(text.replace(/\s{2,}/g, ' ').trim());
    paragraph = [];
  };

  const isBullet = l => /^\s*([\u2022\u2023\u25E6\u2043\u2219*\-\u2013]|\d{1,2}[.)])\s+/.test(l);

  const looksLikeHeading = (l, next) => {
    const t = l.trim();
    if (t.length === 0 || t.length > 80) return false;
    if (/[.,;:]$/.test(t)) return false;
    if (isBullet(t)) return false;
    if (/^\d+$/.test(t)) return false;
    const words = t.split(/\s+/);
    if (words.length > 12) return false;
    const upper = t === t.toUpperCase() && /[A-Z]/.test(t);
    const numbered = /^\d+(\.\d+)*\.?\s+\S/.test(t);
    const titleish = words.length <= 8 &&
      words.filter(w => /^[A-Z]/.test(w)).length >= Math.ceil(words.length * 0.6);
    return (upper || numbered || titleish) && (next === '' || next === undefined);
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    const next = lines[i + 1] !== undefined ? lines[i + 1].trim() : undefined;
    if (line === '') { flush(); continue; }

    if (isBullet(line)) {
      flush();
      blocks.push(line.replace(
        /^\s*([\u2022\u2023\u25E6\u2043\u2219*\-\u2013]|\d{1,2}[.)])\s+/,
        m => (/\d/.test(m) ? m.trim() + ' ' : '- ')
      ));
      continue;
    }

    if (looksLikeHeading(line, next)) {
      flush();
      const depth = /^\d+\.\d+\.\d+/.test(line) ? '####'
        : /^\d+\.\d+/.test(line) ? '###' : '##';
      blocks.push(`${depth} ${line.replace(/\s+/g, ' ')}`);
      continue;
    }
    paragraph.push(line);
  }
  flush();
  return blocks.join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
}

async function convertPdf(buffer, { pageMarkers = false } = {}) {
  const parser = new PDFParse({ data: buffer });

  try {
    // v2 exposes info and text separately; exact shapes vary a little between
    // builds, so read defensively rather than assuming one layout.
    let title = null;
    try {
      const info = await parser.getInfo();
      const meta = (info && (info.info || info.metadata || info)) || {};
      if (typeof meta.Title === 'string' && meta.Title.trim()) title = meta.Title.trim();
    } catch (e) {
      // Info is optional — a missing document dictionary shouldn't fail the call.
    }

    const result = await parser.getText();

    const pageTexts = Array.isArray(result.pages)
      ? result.pages.map(p => (typeof p === 'string' ? p : (p && (p.text || p.content)) || ''))
      : [];

    const whole = typeof result.text === 'string' && result.text.length
      ? result.text
      : pageTexts.join('\n\n');

    const markdown = pageMarkers && pageTexts.length
      ? pageTexts
          .map((p, i) => `${i > 0 ? '\n---\n\n' : ''}<!-- page ${i + 1} -->\n\n${textToMarkdown(p)}`)
          .join('\n\n')
      : textToMarkdown(whole);

    const pages = result.total || pageTexts.length || 1;

    return { markdown, pages, title };
  } finally {
    // v2 keeps a worker alive per parser instance; skipping destroy would leak
    // memory on every paid call.
    await parser.destroy().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Base RPC + gas statistics.
//
// Everything here is computed from public Base chain data via eth_feeHistory
// and eth_getBlockByNumber. Nothing is resold: the chain is public and the
// forecast is our own derived work. Any caller can reproduce these numbers
// from the same RPC, which is the point — the output is auditable.
// ---------------------------------------------------------------------------
async function rpc(method, params = []) {
  const res = await fetch(BASE_RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
  });
  if (!res.ok) throw new Error(`Base RPC ${res.status}`);
  const json = await res.json();
  if (json.error) throw new Error(`Base RPC: ${json.error.message}`);
  return json.result;
}

const weiToGwei = wei => Number(wei) / 1e9;

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

async function gasSnapshot(horizonMinutes) {
  const history = await rpc('eth_feeHistory', [
    '0x' + FEE_HISTORY_BLOCKS.toString(16), 'latest', [50]
  ]);

  const fees = history.baseFeePerGas.map(h => Number(BigInt(h)));
  const ratios = (history.gasUsedRatio || []).map(Number);
  const oldestBlock = Number(BigInt(history.oldestBlock));

  // The last entry of baseFeePerGas is the *next* block's base fee, which is
  // exactly what a transaction submitted now would pay.
  const current = fees[fees.length - 1];
  const currentBlock = oldestBlock + fees.length - 1;

  const sorted = [...fees].sort((a, b) => a - b);
  const median = percentile(sorted, 0.5);
  const p10 = percentile(sorted, 0.1);
  const p90 = percentile(sorted, 0.9);

  // Realised per-block volatility from log returns.
  const returns = [];
  for (let i = 1; i < fees.length; i++) {
    if (fees[i - 1] > 0 && fees[i] > 0) returns.push(Math.log(fees[i] / fees[i - 1]));
  }
  const mean = returns.reduce((a, b) => a + b, 0) / (returns.length || 1);
  const variance = returns.reduce((a, b) => a + (b - mean) ** 2, 0) / (returns.length || 1);
  const sigma = Math.sqrt(variance);

  const recentRatios = ratios.slice(-30);
  const avgRatio = recentRatios.reduce((a, b) => a + b, 0) / (recentRatios.length || 1);
  const congestion = avgRatio > 0.7 ? 'congested' : avgRatio > 0.4 ? 'normal' : 'calm';

  const horizonBlocks = Math.max(1, Math.round((horizonMinutes * 60) / BASE_BLOCK_SECONDS));

  // Mean-reverting log random walk: pull partway toward the recent median,
  // then widen by realised volatility scaled to the horizon.
  const drift = Math.log((median || current) / current) * MEAN_REVERSION;
  const center = current * Math.exp(drift);
  const band = Z_80 * sigma * Math.sqrt(horizonBlocks);

  return {
    currentBlock,
    targetBlock: currentBlock + horizonBlocks,
    horizonBlocks,
    current,
    congestion,
    avgRatio,
    median, p10, p90, sigma,
    blocksObserved: fees.length,
    center,
    low: Math.max(1, center * Math.exp(-band)),
    high: center * Math.exp(band)
  };
}

async function baseFeeAtBlock(blockNumber) {
  const block = await rpc('eth_getBlockByNumber', ['0x' + blockNumber.toString(16), false]);
  if (!block) return null;
  return {
    baseFee: Number(BigInt(block.baseFeePerGas)),
    timestamp: Number(BigInt(block.timestamp)) * 1000
  };
}

const round = (n, d = 6) => Number(n.toFixed(d));

// ---------------------------------------------------------------------------
// 1. Human UI homepage
// ---------------------------------------------------------------------------
app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Lotus Network API — metered services on Base</title>
      <link rel="preconnect" href="https://fonts.googleapis.com">
      <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
      <link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap" rel="stylesheet">
      <style>
        :root {
          --ink:    #0B1420;
          --panel:  #12202E;
          --rule:   #1E3346;
          --bone:   #E8E2D4;
          --dim:    #7A8FA3;
          --amber:  #E8A33D;
          --teal:   #6FC3B8;
          --red:    #E2685C;
          --mono: 'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, monospace;
          --display: 'Space Grotesk', -apple-system, BlinkMacSystemFont, sans-serif;
        }

        * { box-sizing: border-box; }

        body {
          margin: 0;
          background: var(--ink);
          color: var(--bone);
          font-family: var(--mono);
          font-size: 14px;
          line-height: 1.5;
          -webkit-font-smoothing: antialiased;
          background-image:
            repeating-linear-gradient(0deg, rgba(255,255,255,0.012) 0 1px, transparent 1px 3px);
        }

        .shell { max-width: 660px; margin: 0 auto; padding: 0 20px 72px; }

        /* ---- instrument header ---- */
        .bar {
          display: flex; align-items: center; gap: 12px;
          padding: 14px 0; border-bottom: 1px solid var(--rule);
          font-size: 11px; letter-spacing: 0.14em; text-transform: uppercase;
          color: var(--dim);
        }
        .bar .mark { color: var(--bone); letter-spacing: 0.2em; font-weight: 600; }
        .bar .spacer { flex: 1; }
        .lamp {
          width: 6px; height: 6px; border-radius: 50%;
          background: var(--rule); display: inline-block; margin-right: 6px;
          vertical-align: 1px;
        }
        .lamp.on { background: var(--teal); box-shadow: 0 0 8px var(--teal); }

        /* ---- hero ---- */
        .hero { padding: 56px 0 40px; border-bottom: 1px solid var(--rule); }
        .eyebrow {
          font-size: 11px; letter-spacing: 0.22em; text-transform: uppercase;
          color: var(--amber); margin-bottom: 18px;
        }
        h1 {
          font-family: var(--display);
          font-weight: 700; font-size: 40px; line-height: 1.05;
          letter-spacing: -0.02em; margin: 0 0 16px;
        }
        h1 em { font-style: normal; color: var(--amber); }
        .lede { color: var(--dim); max-width: 46ch; margin: 0; }
        .lede a { color: var(--bone); text-decoration: none; border-bottom: 1px solid var(--rule); }
        .lede a:hover { border-color: var(--amber); }

        /* ---- section scaffolding ---- */
        .sec { padding: 32px 0; border-bottom: 1px solid var(--rule); }
        .sec-label {
          font-size: 11px; letter-spacing: 0.18em; text-transform: uppercase;
          color: var(--dim); margin-bottom: 16px; display: flex; gap: 10px; align-items: baseline;
        }
        .sec-label .idx { color: var(--rule); }

        /* ---- rate card ---- */
        .rate { display: block; }
        .rate input { position: absolute; opacity: 0; pointer-events: none; }
        .rate label {
          display: grid; grid-template-columns: 14px 1fr auto;
          gap: 14px; align-items: baseline;
          padding: 13px 14px; border: 1px solid var(--rule); margin-bottom: -1px;
          cursor: pointer; transition: background 0.12s, border-color 0.12s;
        }
        .rate label:hover { background: #16283A; }
        .rate .tick { color: var(--rule); }
        .rate .name { color: var(--dim); }
        .rate .price { color: var(--dim); font-variant-numeric: tabular-nums; }
        .rate input:checked + label { border-color: var(--amber); background: #16283A; position: relative; z-index: 1; }
        .rate input:checked + label .tick { color: var(--amber); }
        .rate input:checked + label .name { color: var(--bone); }
        .rate input:checked + label .price { color: var(--amber); }
        .rate input:focus-visible + label { outline: 2px solid var(--teal); outline-offset: 2px; }
        .rate .sub { grid-column: 2 / -1; font-size: 12px; color: var(--dim); opacity: 0.75; margin-top: 3px; }

        /* ---- fields ---- */
        .field { margin-bottom: 18px; }
        .field:last-child { margin-bottom: 0; }
        label.cap {
          display: block; font-size: 11px; letter-spacing: 0.16em;
          text-transform: uppercase; color: var(--dim); margin-bottom: 7px;
        }
        input[type=text], input[type=number], select {
          width: 100%; padding: 12px 13px;
          background: var(--ink); color: var(--bone);
          border: 1px solid var(--rule); border-radius: 0;
          font-family: var(--mono); font-size: 14px;
        }
        input[type=text]:focus, input[type=number]:focus, select:focus {
          outline: none; border-color: var(--amber);
        }
        input[type=file] { color: var(--dim); font-family: var(--mono); font-size: 12px; width: 100%; }
        input[type=file]::file-selector-button {
          background: transparent; color: var(--bone); border: 1px solid var(--rule);
          padding: 8px 12px; margin-right: 12px; font-family: var(--mono); font-size: 12px;
          cursor: pointer;
        }
        .note { font-size: 12px; color: var(--dim); opacity: 0.7; margin-top: 7px; }

        /* ---- run ---- */
        .run {
          width: 100%; display: flex; justify-content: space-between; align-items: center;
          padding: 15px 16px; margin-top: 4px;
          background: var(--amber); color: var(--ink);
          border: none; border-radius: 0; cursor: pointer;
          font-family: var(--mono); font-weight: 600; font-size: 13px;
          letter-spacing: 0.14em; text-transform: uppercase;
          transition: filter 0.12s;
        }
        .run:hover:not(:disabled) { filter: brightness(1.12); }
        .run:disabled { background: var(--rule); color: var(--dim); cursor: wait; }
        .run .amt { font-variant-numeric: tabular-nums; letter-spacing: 0.04em; }

        /* ---- SIGNATURE 1: handshake ladder ---- */
        .ladder { margin-top: 22px; display: none; }
        .ladder.show { display: block; }
        .rung {
          display: grid; grid-template-columns: 22px 1fr auto; gap: 12px;
          align-items: center; padding: 7px 0; font-size: 12px;
          color: var(--rule); transition: color 0.2s;
        }
        .rung .n { font-variant-numeric: tabular-nums; }
        .rung .track { height: 1px; background: var(--rule); transition: background 0.2s; }
        .rung .st { font-size: 10px; letter-spacing: 0.16em; text-transform: uppercase; }
        .rung.active { color: var(--amber); }
        .rung.active .track { background: var(--amber); }
        .rung.done { color: var(--teal); }
        .rung.done .track { background: var(--teal); }
        .rung.failed { color: var(--red); }
        .rung.failed .track { background: var(--red); }

        /* ---- output ---- */
        .out { display: none; padding-top: 32px; }
        .out.show { display: block; }
        .out img { width: 100%; display: block; border: 1px solid var(--rule); }
        pre.data {
          margin: 0; padding: 16px; background: #0D1926; border: 1px solid var(--rule);
          font-family: var(--mono); font-size: 11.5px; line-height: 1.65; color: var(--dim);
          max-height: 320px; overflow: auto; white-space: pre-wrap; word-break: break-word;
        }
        pre.data .k { color: var(--bone); }

        /* ---- SIGNATURE 2: the fee band meter ---- */
        .meter { margin-bottom: 22px; }
        .meter-head {
          display: flex; justify-content: space-between; align-items: baseline;
          font-size: 11px; letter-spacing: 0.14em; text-transform: uppercase;
          color: var(--dim); margin-bottom: 14px;
        }
        .meter-head .verdict.held { color: var(--teal); }
        .meter-head .verdict.missed { color: var(--red); }
        .band { position: relative; height: 62px; }
        .band .axis { position: absolute; top: 30px; left: 0; right: 0; height: 1px; background: var(--rule); }
        .band .range {
          position: absolute; top: 22px; height: 17px;
          background: rgba(232,163,61,0.16); border-left: 1px solid var(--amber); border-right: 1px solid var(--amber);
        }
        .band .needle { position: absolute; top: 16px; width: 1px; height: 29px; background: var(--amber); }
        .band .needle::after {
          content: ''; position: absolute; top: -4px; left: -3px;
          width: 7px; height: 7px; background: var(--amber); transform: rotate(45deg);
        }
        .band .actual { position: absolute; top: 16px; width: 1px; height: 29px; background: var(--teal); }
        .band .actual::after {
          content: ''; position: absolute; top: -4px; left: -3px;
          width: 7px; height: 7px; border-radius: 50%; background: var(--teal);
        }
        .band .actual.missed { background: var(--red); }
        .band .actual.missed::after { background: var(--red); }
        .band .tag {
          position: absolute; top: 46px; font-size: 10px; letter-spacing: 0.08em;
          color: var(--dim); white-space: nowrap; transform: translateX(-50%);
        }
        .band .tag.hi { top: 0; }
        .band .tag.amber { color: var(--amber); }
        .band .tag.teal { color: var(--teal); }
        .band .tag.red { color: var(--red); }

        /* ---- actions + meta ---- */
        .acts { display: flex; gap: 1px; margin-top: 1px; }
        .acts button {
          flex: 1; padding: 12px 8px; background: var(--panel); color: var(--bone);
          border: 1px solid var(--rule); border-radius: 0; cursor: pointer;
          font-family: var(--mono); font-size: 11px; letter-spacing: 0.12em;
          text-transform: uppercase;
        }
        .acts button:hover { border-color: var(--amber); color: var(--amber); }
        .meta { margin-top: 16px; font-size: 12px; color: var(--dim); line-height: 1.75; word-break: break-all; }
        .meta a { color: var(--teal); text-decoration: none; }
        .meta a:hover { text-decoration: underline; }
        .toast { margin-top: 10px; font-size: 12px; color: var(--teal); min-height: 1.2em; }
        .toast.bad { color: var(--red); }
        .fail {
          margin-top: 18px; padding: 13px 14px; border-left: 2px solid var(--red);
          background: rgba(226,104,92,0.07); color: var(--bone);
          font-size: 12.5px; white-space: pre-wrap; word-break: break-word; display: none;
        }
        .fail.show { display: block; }

        /* ---- footer ---- */
        footer {
          padding: 28px 0; font-size: 11px; letter-spacing: 0.1em;
          text-transform: uppercase; color: var(--dim);
          display: flex; flex-wrap: wrap; gap: 20px;
        }
        footer a { color: var(--dim); text-decoration: none; border-bottom: 1px solid transparent; }
        footer a:hover { color: var(--amber); border-color: var(--amber); }

        .hidden { display: none !important; }

        @media (max-width: 560px) {
          h1 { font-size: 30px; }
          .hero { padding: 40px 0 32px; }
        }
        @media (prefers-reduced-motion: reduce) {
          * { transition: none !important; }
        }
      </style>
    </head>
    <body>
      <div class="shell">

        <div class="bar">
          <span class="mark">Lotus Network</span>
          <span class="spacer"></span>
          <span id="statusLamp"><span class="lamp"></span><span id="statusText">checking</span></span>
        </div>

        <div class="hero">
          <div class="eyebrow">Metered access · Base mainnet</div>
          <h1>Five services.<br>Priced <em>per call</em>.</h1>
          <p class="lede">
            Settled in USDC over <a href="/openapi.json">x402</a>. No key, no account, no
            subscription — your wallet is asked once per request, and the receipt is on-chain.
          </p>
        </div>

        <div class="sec">
          <div class="sec-label"><span class="idx">01</span><span>Rate card</span></div>
          <div class="rate" id="rateCard">
            <input type="radio" name="svc" id="r_image" value="image" checked onchange="switchMode()">
            <label for="r_image">
              <span class="tick">▸</span>
              <span class="name">Image generation</span>
              <span class="price">$${PRICE_IMAGE}</span>
              <span class="sub">FLUX text-to-image. Returns bytes plus a durable URL.</span>
            </label>

            <input type="radio" name="svc" id="r_pdf" value="pdf" onchange="switchMode()">
            <label for="r_pdf">
              <span class="tick">▸</span>
              <span class="name">PDF to Markdown</span>
              <span class="price">$${PRICE_PDF}</span>
              <span class="sub">Text layer extraction, unwrapped into clean Markdown.</span>
            </label>

            <input type="radio" name="svc" id="r_preflight" value="preflight" onchange="switchMode()">
            <label for="r_preflight">
              <span class="tick">▸</span>
              <span class="name">Gas preflight</span>
              <span class="price">$${PRICE_PREFLIGHT}</span>
              <span class="sub">Base fee now, plus an 80% range for your horizon.</span>
            </label>

            <input type="radio" name="svc" id="r_decision" value="decision" onchange="switchMode()">
            <label for="r_decision">
              <span class="tick">▸</span>
              <span class="name">Gas decision</span>
              <span class="price">$${PRICE_DECISION}</span>
              <span class="sub">Journals your call against the snapshot. Returns an ID.</span>
            </label>

            <input type="radio" name="svc" id="r_audit" value="audit" onchange="switchMode()">
            <label for="r_audit">
              <span class="tick">▸</span>
              <span class="name">Gas audit</span>
              <span class="price">$${PRICE_AUDIT}</span>
              <span class="sub">Checks that ID against what the chain actually did.</span>
            </label>
          </div>
        </div>

        <div class="sec">
          <div class="sec-label"><span class="idx">02</span><span>Input</span></div>

          <div id="f_image">
            <div class="field">
              <label class="cap" for="prompt">Prompt</label>
              <input type="text" id="prompt" placeholder="a harbour crane at dawn, long exposure">
            </div>
          </div>

          <div id="f_pdf" class="hidden">
            <div class="field">
              <label class="cap" for="pdfUrl">PDF address</label>
              <input type="text" id="pdfUrl" placeholder="https://example.com/report.pdf">
            </div>
            <div class="field">
              <label class="cap" for="pdfFile">Or send a file</label>
              <input type="file" id="pdfFile" accept="application/pdf">
              <div class="note">20 MB ceiling. Scanned PDFs carry no text layer and return empty.</div>
            </div>
          </div>

          <div id="f_preflight" class="hidden">
            <div class="field">
              <label class="cap" for="horizon1">Horizon · minutes</label>
              <input type="number" id="horizon1" value="5" min="1" max="60">
            </div>
          </div>

          <div id="f_decision" class="hidden">
            <div class="field">
              <label class="cap" for="stance">Stance</label>
              <select id="stance">
                <option value="wait">wait — hold, expecting cheaper gas</option>
                <option value="execute">execute — transact now</option>
              </select>
            </div>
            <div class="field">
              <label class="cap" for="horizon2">Horizon · minutes</label>
              <input type="number" id="horizon2" value="15" min="1" max="60">
              <div class="note">Keep the ID it returns. The audit needs it once the horizon elapses.</div>
            </div>
          </div>

          <div id="f_audit" class="hidden">
            <div class="field">
              <label class="cap" for="decisionId">Decision ID</label>
              <input type="text" id="decisionId" placeholder="32 hex characters">
              <div class="note">Returns pending until the target block is reached.</div>
            </div>
          </div>
        </div>

        <div class="sec">
          <div class="sec-label"><span class="idx">03</span><span>Settlement</span></div>

          <button class="run" id="btn" onclick="run()">
            <span>Run</span><span class="amt" id="btnAmt">$${PRICE_IMAGE}</span>
          </button>

          <div class="ladder" id="ladder">
            <div class="rung" data-step="1"><span class="n">1</span><span class="track"></span><span class="st">Read terms</span></div>
            <div class="rung" data-step="2"><span class="n">2</span><span class="track"></span><span class="st">Connect wallet</span></div>
            <div class="rung" data-step="3"><span class="n">3</span><span class="track"></span><span class="st">Sign authorization</span></div>
            <div class="rung" data-step="4"><span class="n">4</span><span class="track"></span><span class="st">Settle on Base</span></div>
            <div class="rung" data-step="5"><span class="n">5</span><span class="track"></span><span class="st">Deliver</span></div>
          </div>

          <div class="fail" id="fail"></div>

          <div class="out" id="out">
            <div class="meter hidden" id="meter">
              <div class="meter-head">
                <span id="meterTitle">Fee band · gwei</span>
                <span class="verdict" id="meterVerdict"></span>
              </div>
              <div class="band" id="band"></div>
            </div>

            <img id="image" alt="" class="hidden">
            <pre class="data hidden" id="data"></pre>

            <div class="acts hidden" id="imageActs">
              <button onclick="saveImage()">Save</button>
              <button id="copyImgBtn" onclick="copyImage()">Copy image</button>
              <button onclick="copyLink()">Copy link</button>
            </div>
            <div class="acts hidden" id="textActs">
              <button onclick="copyText()">Copy output</button>
            </div>

            <div class="toast" id="toast"></div>
            <div class="meta" id="meta"></div>
          </div>
        </div>

        <footer>
          <a href="/openapi.json">OpenAPI</a>
          <a href="/llms.txt">llms.txt</a>
          <a href="/healthz">Status</a>
          <span>USDC · eip155:8453</span>
        </footer>
      </div>

      <script>
        const PRICE = {
          image: '${PRICE_IMAGE}', pdf: '${PRICE_PDF}', preflight: '${PRICE_PREFLIGHT}',
          decision: '${PRICE_DECISION}', audit: '${PRICE_AUDIT}'
        };
        const MODES = ['image', 'pdf', 'preflight', 'decision', 'audit'];

        let mode = 'image';
        let lastResult = null;
        let lastText = '';
        let pngPromise = null;
        let pngBlob = null;
        let clipboardBlocked = false;

        const $ = id => document.getElementById(id);

        // ---- status lamp ----
        fetch('/healthz').then(r => r.json()).then(h => {
          $('statusLamp').innerHTML = '<span class="lamp on"></span>' +
            (h.endpoints ? h.endpoints.length : 0) + ' services live';
        }).catch(() => {
          $('statusText').textContent = 'status unavailable';
        });

        function switchMode() {
          const picked = document.querySelector('input[name=svc]:checked');
          mode = picked ? picked.value : 'image';
          MODES.forEach(m => $('f_' + m).classList.toggle('hidden', m !== mode));
          $('btnAmt').textContent = '$' + PRICE[mode];
          $('out').classList.remove('show');
          $('fail').classList.remove('show');
          $('ladder').classList.remove('show');
        }

        // ---- handshake ladder ----
        function resetLadder() {
          document.querySelectorAll('.rung').forEach(r => r.className = 'rung');
          $('ladder').classList.remove('show');
        }
        function markStep(n, state) {
          $('ladder').classList.add('show');
          document.querySelectorAll('.rung').forEach(r => {
            const s = Number(r.dataset.step);
            if (s < n) { r.className = 'rung done'; }
            else if (s === n) { r.className = 'rung ' + (state || 'active'); }
          });
        }
        function failLadder() {
          const active = document.querySelector('.rung.active');
          if (active) active.className = 'rung failed';
        }

        // ---- helpers ----
        function randomNonce() {
          const bytes = new Uint8Array(32);
          window.crypto.getRandomValues(bytes);
          return '0x' + Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
        }
        function b64ToJson(v) {
          try { return JSON.parse(decodeURIComponent(escape(atob(v)))); }
          catch (e) { try { return JSON.parse(atob(v)); } catch (e2) { return null; } }
        }
        function jsonToB64(o) { return btoa(unescape(encodeURIComponent(JSON.stringify(o)))); }
        function toast(msg, bad) {
          const el = $('toast');
          el.className = bad ? 'toast bad' : 'toast';
          el.textContent = msg;
          setTimeout(() => { if (el.textContent === msg) el.textContent = ''; }, 4000);
        }
        function slugify(t) {
          return (t || 'file').toLowerCase().replace(/[^a-z0-9]+/g, '-')
            .replace(/^-|-$/g, '').slice(0, 40) || 'file';
        }
        const IS_APPLE = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
          (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

        // ---- x402 V2 handshake, shared by every endpoint ----
        async function paidCall(method, path, body, step) {
          step = step || (() => {});

          step(1);
          const init = { method };
          if (body) { init.headers = { 'Content-Type': 'application/json' }; init.body = JSON.stringify(body); }
          const probe = await fetch(path, init);

          if (probe.status !== 402) {
            const text = await probe.text();
            if (probe.ok) throw new Error('Served without payment — this route is not gated.\\n' + text);
            throw new Error('Expected a 402 challenge, got ' + probe.status + '.\\n' + text);
          }

          const header = probe.headers.get('PAYMENT-REQUIRED');
          let challenge = header ? b64ToJson(header) : null;
          if (!challenge) { try { challenge = await probe.clone().json(); } catch (e) {} }
          if (!challenge) throw new Error('402 received but the PAYMENT-REQUIRED header could not be read.');

          const chosen = (challenge.accepts || []).find(
            o => o.scheme === 'exact' && String(o.network || '').includes('8453'));
          if (!chosen) throw new Error('No exact/Base payment option offered:\\n' + JSON.stringify(challenge));

          const chainId = parseInt(String(chosen.network).split(':').pop(), 10);
          const amount = String(chosen.amount ?? chosen.maxAmountRequired);
          const asset = chosen.asset;
          const extra = chosen.extra || {};
          const tokenName = extra.name || 'USD Coin';
          const tokenVersion = extra.version || '2';
          const timeout = chosen.maxTimeoutSeconds || 600;
          if (!amount || amount === 'undefined' || !asset) {
            throw new Error('Challenge is missing amount or asset:\\n' + JSON.stringify(chosen));
          }

          step(2);
          const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
          const userAddress = accounts[0];
          const wantHex = '0x' + chainId.toString(16);
          let current = await window.ethereum.request({ method: 'eth_chainId' });
          if (current !== wantHex) {
            try {
              await window.ethereum.request({
                method: 'wallet_switchEthereumChain', params: [{ chainId: wantHex }] });
            } catch (e) {
              if (e.code === 4902) {
                await window.ethereum.request({
                  method: 'wallet_addEthereumChain',
                  params: [{
                    chainId: '0x2105', chainName: 'Base',
                    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
                    rpcUrls: ['https://mainnet.base.org'],
                    blockExplorerUrls: ['https://basescan.org']
                  }]
                });
              } else throw new Error('The wallet would not switch to Base: ' + (e.message || e.code));
            }
            current = await window.ethereum.request({ method: 'eth_chainId' });
            if (current !== wantHex) throw new Error('Wallet is on chain ' + current + '; Base is ' + wantHex + '.');
          }

          step(3);
          const now = Math.floor(Date.now() / 1000);
          const authorization = {
            from: userAddress, to: chosen.payTo, value: amount,
            validAfter: String(now - 300), validBefore: String(now + timeout),
            nonce: randomNonce()
          };
          const typedData = {
            domain: { name: tokenName, version: tokenVersion, chainId, verifyingContract: asset },
            types: {
              EIP712Domain: [
                { name: 'name', type: 'string' }, { name: 'version', type: 'string' },
                { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }
              ],
              TransferWithAuthorization: [
                { name: 'from', type: 'address' }, { name: 'to', type: 'address' },
                { name: 'value', type: 'uint256' }, { name: 'validAfter', type: 'uint256' },
                { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' }
              ]
            },
            primaryType: 'TransferWithAuthorization', message: authorization
          };
          const signature = await window.ethereum.request({
            method: 'eth_signTypedData_v4', params: [userAddress, JSON.stringify(typedData)] });

          step(4);
          const paymentPayload = {
            x402Version: challenge.x402Version ?? 2,
            accepted: {
              scheme: chosen.scheme, network: chosen.network, amount, asset,
              payTo: chosen.payTo, maxTimeoutSeconds: timeout,
              extra: {
                assetTransferMethod: extra.assetTransferMethod || 'eip3009',
                name: tokenName, version: tokenVersion
              }
            },
            payload: { signature, authorization }
          };
          if (challenge.extensions) paymentPayload.extensions = challenge.extensions;

          // In x402 V2 the resource object sits at the TOP LEVEL of the
          // PaymentRequired challenge, not inside an accepts entry. The
          // facilitator rejects the Bazaar discovery request without it.
          paymentPayload.resource = challenge.resource || {
            url: window.location.origin + path.split('?')[0],
            description: chosen.description || '',
            mimeType: chosen.mimeType || 'application/json'
          };

          const headers = { 'PAYMENT-SIGNATURE': jsonToB64(paymentPayload) };
          if (body) headers['Content-Type'] = 'application/json';
          const paid = await fetch(path, {
            method, headers, body: body ? JSON.stringify(body) : undefined });

          const rawBody = await paid.text();
          const settleHeader = paid.headers.get('PAYMENT-RESPONSE');
          const settlement = settleHeader ? b64ToJson(settleHeader) : null;

          if (!paid.ok) {
            let detail = rawBody;
            try {
              const p = JSON.parse(rawBody);
              detail = p.error || p.errorReason || p.message || rawBody;
            } catch (e) {}
            if (settlement) detail += '\\n\\nSettlement: ' + JSON.stringify(settlement);
            throw new Error(detail);
          }

          step(5);
          return { data: JSON.parse(rawBody), settlement };
        }

        // ---- the fee band ----
        function drawBand(low, center, high, actual, held) {
          const lo = Math.min(low, actual === null ? low : actual);
          const hi = Math.max(high, actual === null ? high : actual);
          const pad = (hi - lo) * 0.25 || Math.max(hi * 0.1, 0.0001);
          const min = lo - pad, max = hi + pad, span = max - min || 1;
          const pct = v => ((v - min) / span) * 100;

          let html = '<div class="axis"></div>';
          html += '<div class="range" style="left:' + pct(low) + '%;width:' + (pct(high) - pct(low)) + '%"></div>';
          html += '<div class="tag hi amber" style="left:' + pct(low) + '%">' + low + '</div>';
          html += '<div class="tag hi amber" style="left:' + pct(high) + '%">' + high + '</div>';
          html += '<div class="needle" style="left:' + pct(center) + '%"></div>';
          html += '<div class="tag amber" style="left:' + pct(center) + '%">forecast ' + center + '</div>';

          if (actual !== null) {
            const cls = held ? '' : ' missed';
            const tagCls = held ? 'teal' : 'red';
            html += '<div class="actual' + cls + '" style="left:' + pct(actual) + '%"></div>';
            html += '<div class="tag ' + tagCls + '" style="left:' + pct(actual) + '%;top:46px">actual ' + actual + '</div>';
          }

          $('band').innerHTML = html;
          $('meter').classList.remove('hidden');
        }

        // ---- output renderers ----
        function showImage(data) {
          const img = $('image');
          img.src = 'data:' + (data.mimeType || 'image/webp') + ';base64,' + data.image;
          img.classList.remove('hidden');
          $('data').classList.add('hidden');
          $('meter').classList.add('hidden');
          $('imageActs').classList.remove('hidden');
          $('textActs').classList.add('hidden');
          preparePng();
        }
        function showData(obj) {
          lastText = typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2);
          $('data').textContent = lastText;
          $('data').classList.remove('hidden');
          $('image').classList.add('hidden');
          $('imageActs').classList.add('hidden');
          $('textActs').classList.remove('hidden');
        }

        // ---- image helpers ----
        function preparePng() {
          const img = $('image');
          pngPromise = img.decode().then(() => {
            const c = document.createElement('canvas');
            c.width = img.naturalWidth; c.height = img.naturalHeight;
            c.getContext('2d').drawImage(img, 0, 0);
            return new Promise((res, rej) =>
              c.toBlob(b => (b ? res(b) : rej(new Error('encode failed'))), 'image/png'));
          }).then(b => { pngBlob = b; return b; });
        }
        function openInTab() {
          if (!lastResult || !lastResult.imageUrl) return;
          window.open(lastResult.imageUrl, '_blank');
          toast('Opened full size — long-press to add to Photos');
        }
        function saveImage() {
          if (!lastResult) return;
          const name = slugify(lastResult.prompt) + '.png';
          if (pngBlob) {
            const file = new File([pngBlob], name, { type: 'image/png' });
            if (IS_APPLE && navigator.canShare && navigator.canShare({ files: [file] })) {
              navigator.share({ files: [file] })
                .catch(e => { if (e && e.name !== 'AbortError') openInTab(); });
              return;
            }
            try {
              const url = URL.createObjectURL(pngBlob);
              const a = document.createElement('a');
              a.href = url; a.download = name;
              document.body.appendChild(a); a.click(); a.remove();
              setTimeout(() => URL.revokeObjectURL(url), 10000);
              toast('Saved to downloads');
              return;
            } catch (e) {}
          }
          openInTab();
        }
        function copyImage() {
          if (!pngPromise) return;
          if (clipboardBlocked || !navigator.clipboard || !window.ClipboardItem) return shareImage();
          navigator.clipboard.write([new ClipboardItem({ 'image/png': pngPromise })])
            .then(() => toast('Image copied'))
            .catch(() => {
              clipboardBlocked = true;
              $('copyImgBtn').textContent = 'Share image';
              toast('Clipboard is blocked here — tap again to share', true);
            });
        }
        async function shareImage() {
          try {
            const blob = pngBlob || await pngPromise;
            const file = new File([blob], slugify(lastResult && lastResult.prompt) + '.png',
              { type: 'image/png' });
            if (navigator.canShare && navigator.canShare({ files: [file] })) {
              return await navigator.share({ files: [file] });
            }
            throw new Error('unsupported');
          } catch (e) {
            if (e && e.name === 'AbortError') return;
            openInTab();
          }
        }
        async function copyLink() {
          if (!lastResult) return;
          const link = lastResult.absoluteUrl ||
            (lastResult.imageUrl ? window.location.origin + lastResult.imageUrl : null);
          if (!link) return toast('This result has no stored URL', true);
          try { await navigator.clipboard.writeText(link); toast('Link copied'); }
          catch (e) { toast(link, true); }
        }
        async function copyText() {
          if (!lastText) return;
          try { await navigator.clipboard.writeText(lastText); toast('Copied'); }
          catch (e) { toast('Clipboard is blocked here — select the text instead', true); }
        }
        function fileToBase64(file) {
          return new Promise((res, rej) => {
            const r = new FileReader();
            r.onload = () => res(String(r.result).split(',')[1]);
            r.onerror = () => rej(new Error('Could not read that file'));
            r.readAsDataURL(file);
          });
        }

        // ---- main ----
        async function run() {
          const btn = $('btn');
          const failBox = $('fail');

          const fail = m => {
            failLadder();
            failBox.textContent = m;
            failBox.classList.add('show');
          };

          if (!window.ethereum) {
            resetLadder();
            return fail('No wallet found in this browser. Open this page inside MetaMask, Coinbase Wallet, or Phantom.');
          }

          lastResult = null; lastText = ''; pngPromise = null; pngBlob = null; clipboardBlocked = false;
          $('copyImgBtn').textContent = 'Copy image';
          $('out').classList.remove('show');
          $('meter').classList.add('hidden');
          $('meterVerdict').className = 'verdict';
          $('meterVerdict').textContent = '';
          failBox.classList.remove('show');
          resetLadder();
          btn.disabled = true;

          const step = n => markStep(n);

          try {
            let settlement = null;
            let metaHtml = '';

            if (mode === 'image') {
              const prompt = $('prompt').value.trim();
              if (!prompt) throw new Error('Enter a prompt first.');
              const r = await paidCall('GET',
                '/api/v1/generate-image?prompt=' + encodeURIComponent(prompt), null, step);
              settlement = r.settlement;
              if (!r.data.image) throw new Error('Payment settled but no image came back.');
              lastResult = r.data;
              showImage(r.data);
              metaHtml = 'Model ' + (r.data.model || '') + ' · ' + (r.data.mimeType || '');

            } else if (mode === 'pdf') {
              const url = $('pdfUrl').value.trim();
              const file = $('pdfFile').files[0];
              if (!url && !file) throw new Error('Give a PDF address or choose a file.');
              const body = {};
              if (file) {
                if (file.size > 20 * 1024 * 1024) throw new Error('That file is over the 20 MB ceiling.');
                body.pdf = await fileToBase64(file);
              } else body.url = url;

              const r = await paidCall('POST', '/api/v1/pdf-to-markdown', body, step);
              settlement = r.settlement;
              lastResult = r.data;
              showData(r.data.markdown || '(no text layer found — this PDF is probably a scan)');
              metaHtml = r.data.pages + ' pages · ' + r.data.characters + ' characters' +
                (r.data.title ? ' · ' + r.data.title : '');

            } else if (mode === 'preflight') {
              const h = Math.max(1, Math.min(60, Number($('horizon1').value) || 5));
              const r = await paidCall('GET', '/api/v1/gas/preflight?horizonMinutes=' + h, null, step);
              settlement = r.settlement;
              lastResult = r.data;
              const f = r.data.forecast;
              $('meterTitle').textContent = 'Fee band · gwei · ' + h + ' min';
              drawBand(f.lowGwei, f.centerGwei, f.highGwei, r.data.current.baseFeeGwei, true);
              $('meterVerdict').textContent = r.data.current.congestion;
              showData(r.data);
              metaHtml = 'Block ' + r.data.block + ' · base fee ' +
                r.data.current.baseFeeGwei + ' gwei · ' + r.data.recent.blocks + ' blocks observed';

            } else if (mode === 'decision') {
              const body = {
                stance: $('stance').value,
                horizonMinutes: Math.max(1, Math.min(60, Number($('horizon2').value) || 15))
              };
              const r = await paidCall('POST', '/api/v1/gas/decision', body, step);
              settlement = r.settlement;
              lastResult = r.data;
              const s = r.data.snapshot;
              $('meterTitle').textContent = 'Fee band at journal time · gwei';
              drawBand(s.lowGwei, s.centerGwei, s.highGwei, s.baseFeeGwei, true);
              $('meterVerdict').textContent = 'recorded';
              showData(r.data);
              metaHtml = 'Auditable from ' + new Date(r.data.auditableAt).toLocaleTimeString() +
                ' · target block ' + r.data.targetBlock + '<br>ID ' + r.data.decisionId;

            } else if (mode === 'audit') {
              const id = $('decisionId').value.trim();
              if (!/^[a-f0-9]{32}$/.test(id)) throw new Error('A decision ID is 32 hexadecimal characters.');
              const r = await paidCall('GET', '/api/v1/gas/audit/' + id, null, step);
              settlement = r.settlement;
              lastResult = r.data;
              const f = r.data.forecast;

              if (r.data.status === 'pending') {
                $('meterTitle').textContent = 'Fee band · awaiting block ' + r.data.targetBlock;
                drawBand(f.lowGwei, f.centerGwei, f.highGwei, null, true);
                $('meterVerdict').textContent = 'pending';
                metaHtml = r.data.blocksRemaining + ' blocks to go · about ' +
                  Math.ceil(r.data.secondsRemaining / 60) + ' min';
              } else {
                const held = r.data.rangeContainedActual;
                $('meterTitle').textContent = 'Fee band · resolved at block ' + r.data.actual.block;
                drawBand(f.lowGwei, f.centerGwei, f.highGwei, r.data.actual.baseFeeGwei, held);
                $('meterVerdict').className = 'verdict ' + (held ? 'held' : 'missed');
                $('meterVerdict').textContent = held ? 'range held' : 'range missed';
                metaHtml = r.data.explanation +
                  '<br><a href="' + r.data.verify + '" target="_blank" rel="noopener">Verify on BaseScan</a>';
              }
              showData(r.data);
            }

            const tx = settlement && settlement.transaction;
            if (tx) {
              metaHtml += (metaHtml ? '<br>' : '') +
                'Receipt <a href="https://basescan.org/tx/' + tx +
                '" target="_blank" rel="noopener">' + tx.slice(0, 18) + '…</a>';
            }
            $('meta').innerHTML = metaHtml;
            $('out').classList.add('show');
            markStep(6);   // all five rungs resolve to done
          } catch (err) {
            fail(err.message || String(err));
            console.error(err);
          } finally {
            btn.disabled = false;
          }
        }

        switchMode();
      </script>
    </body>
    </html>
  `);
});

// ---------------------------------------------------------------------------
// 2. Agent-facing discovery documents
// ---------------------------------------------------------------------------
app.get('/openapi.json', (req, res) => {
  const paths = {};
  for (const ep of ENDPOINTS) {
    const operation = {
      operationId: ep.operationId,
      summary: ep.summary,
      tags: ep.tags,
      description: ep.description,
      'x-payment-info': {
        price: { mode: 'fixed', currency: 'USD', amount: Number(ep.price).toFixed(6) },
        protocols: [{ x402: {} }]
      },
      responses: {
        200: {
          description: 'Success',
          content: {
            'application/json': {
              schema: { type: 'object', properties: ep.outputSchema.properties },
              example: ep.outputExample
            }
          }
        },
        402: { description: 'Payment required. Terms are in the PAYMENT-REQUIRED response header.' }
      }
    };
    if (ep.parameters) operation.parameters = ep.parameters;
    if (ep.requestBody) operation.requestBody = ep.requestBody;

    paths[ep.path] = paths[ep.path] || {};
    paths[ep.path][ep.method.toLowerCase()] = operation;
  }

  res.json({
    openapi: '3.0.3',
    info: {
      title: 'Lotus Network API',
      description:
        'Pay-per-call AI, document, and on-chain data services on Base. Image generation, ' +
        'PDF-to-Markdown conversion, and an auditable Base gas forecasting loop. ' +
        'No API key, account, or subscription.',
      version: '1.2.0',
      contact: { email: CONTACT_EMAIL }
    },
    servers: [{ url: BASE_URL }],
    paths
  });
});

// Plain-text summary for agents that prefer prose over a schema.
app.get('/llms.txt', (req, res) => {
  res.type('text/plain').send(
`# Lotus Network API

Pay-per-call services on Base. No API key, no account, no subscription.
Payment uses x402 V2 (exact scheme, eip155:8453, USDC). Send a request with no
PAYMENT-SIGNATURE header to receive a 402 with terms in the PAYMENT-REQUIRED header.

Base URL: ${BASE_URL}
OpenAPI: ${BASE_URL}/openapi.json
Contact: ${CONTACT_EMAIL}

## Endpoints

GET /api/v1/generate-image?prompt=... ($${PRICE_IMAGE})
  Text-to-image via FLUX. Returns base64 plus a durable URL.
  Add &format=binary for raw image bytes instead of JSON.

POST /api/v1/pdf-to-markdown ($${PRICE_PDF})
  Body: {"url": "https://..."} or {"pdf": "<base64>"}
  Returns clean Markdown extracted from the PDF. Scanned PDFs have no text
  layer and will return empty with a note.

GET /api/v1/gas/preflight?horizonMinutes=5 ($${PRICE_PREFLIGHT})
  Current Base gas conditions and an 80% forecast range for the horizon.
  Computed from eth_feeHistory over the last ${FEE_HISTORY_BLOCKS} blocks.

POST /api/v1/gas/decision ($${PRICE_DECISION})
  Body: {"stance": "wait"|"execute", "horizonMinutes": 15}
  Journals the decision against a fresh snapshot, returns a decision_id.

GET /api/v1/gas/audit/{decisionId} ($${PRICE_AUDIT})
  Verifies a journalled decision against the actual base fee at the target
  block. Returns status "pending" if that block has not been reached.

## The gas loop

preflight -> decision -> (wait for horizon) -> audit

This is supporting context for transaction timing, not a trade instruction.
Every figure is derived from public Base RPC data and is reproducible by any
caller against the same chain. The forecast is a mean-reverting log random
walk on realised per-block volatility; the audit reports whether the interval
actually contained the observed value, so calibration is measurable rather
than asserted.
`);
});

// ---------------------------------------------------------------------------
// 3. Facilitator client + resource server
//
//    Bazaar indexing only happens when the CDP facilitator settles a payment
//    for a route that declares discovery metadata. Any other facilitator means
//    Coinbase never sees the traffic and the service is never indexed.
// ---------------------------------------------------------------------------
const usingCdp = Boolean(CDP_KEY_ID && CDP_KEY_SECRET);

if (!usingCdp) {
  console.warn(
    '[x402] CDP keys missing — falling back to PayAI. Payments will work but the ' +
    'service will NOT be indexed for agentic.market.'
  );
}

const facilitatorClient = usingCdp
  ? withBazaar(new HTTPFacilitatorClient(createFacilitatorConfig(CDP_KEY_ID, CDP_KEY_SECRET)))
  : new HTTPFacilitatorClient({ url: process.env.FACILITATOR_URL || 'https://facilitator.payai.network' });

const x402Server = new x402ResourceServer(facilitatorClient);
x402Server.register('eip155:8453', new ExactEvmScheme());
if (usingCdp) x402Server.registerExtension(bazaarResourceServerExtension);

// ---------------------------------------------------------------------------
// 4. Free retrieval endpoint — before the payment middleware, so an already
//    paid-for image can be re-fetched without paying twice. The 128-bit
//    random id is the access credential.
// ---------------------------------------------------------------------------
app.get('/api/v1/image/:id', async (req, res) => {
  if (!/^[a-f0-9]{32}$/.test(req.params.id)) {
    return res.status(400).json({ error: 'Malformed image id' });
  }
  let entry;
  try {
    entry = await loadImage(req.params.id);
  } catch (err) {
    console.error('[storage] load failed:', err);
    return res.status(500).json({ error: 'Storage error' });
  }
  if (!entry) return res.status(404).json({ error: 'Image not found' });

  res.set('Content-Type', entry.mimeType);
  res.set('Cache-Control', 'public, max-age=31536000, immutable');
  if (req.query.download !== undefined) {
    res.set('Content-Disposition',
      `attachment; filename="${slugify(entry.prompt)}.${extFor(entry.mimeType)}"`);
  }
  res.send(entry.buffer);
});

// ---------------------------------------------------------------------------
// 5. Diagnostics, then route protection
// ---------------------------------------------------------------------------
app.use('/api', (req, res, next) => {
  const sig = req.headers['payment-signature'] || req.headers['x-payment'];
  if (!sig) {
    console.log(`[x402] ${req.method} ${req.path} — no PAYMENT-SIGNATURE, issuing 402`);
  } else {
    if (req.headers['x-payment'] && !req.headers['payment-signature']) {
      console.warn('[x402] client sent V1 X-PAYMENT; V2 expects PAYMENT-SIGNATURE');
    }
    console.log(`[x402] paid request: ${req.method} ${req.path}`);
  }
  next();
});

const routes = {};
for (const ep of ENDPOINTS) {
  routes[`${ep.method} ${ep.routePath || ep.path}`] = {
    accepts: [{
      scheme: 'exact',
      price: `$${ep.price}`,
      network: 'eip155:8453',
      payTo: WALLET_ADDRESS
    }],
    description: ep.description,
    mimeType: 'application/json',
    extensions: {
      ...declareDiscoveryExtension({
        input: ep.inputExample,
        inputSchema: ep.inputSchema,
        // POST/PUT/PATCH must declare how the body is encoded, or the
        // extension can't narrow /input/method and the route is rejected.
        ...(ep.method === 'GET' ? {} : { bodyType: 'json' }),
        output: { example: ep.outputExample, schema: ep.outputSchema }
      })
    }
  };
}

app.use(paymentMiddleware(routes, x402Server));

// ---------------------------------------------------------------------------
// 6. Image generation via Replicate
// ---------------------------------------------------------------------------
async function replicateGenerate(prompt) {
  if (!REPLICATE_TOKEN) throw new Error('REPLICATE_API_TOKEN is not set on the server');
  const headers = {
    Authorization: `Bearer ${REPLICATE_TOKEN}`,
    'Content-Type': 'application/json'
  };

  const created = await fetch(
    `https://api.replicate.com/v1/models/${REPLICATE_MODEL}/predictions`,
    {
      method: 'POST',
      headers: { ...headers, Prefer: 'wait=55' },
      body: JSON.stringify({
        input: {
          prompt, num_outputs: 1, aspect_ratio: '1:1',
          output_format: 'webp', output_quality: 90
        }
      })
    }
  );
  if (!created.ok) throw new Error(`Replicate ${created.status}: ${await created.text()}`);

  let prediction = await created.json();
  const deadline = Date.now() + 120000;
  while (['starting', 'processing'].includes(prediction.status) && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 1500));
    const poll = await fetch(prediction.urls.get, { headers });
    if (!poll.ok) throw new Error(`Replicate poll ${poll.status}: ${await poll.text()}`);
    prediction = await poll.json();
  }
  if (prediction.status !== 'succeeded') {
    throw new Error(`Prediction ${prediction.status}: ${prediction.error || 'timed out'}`);
  }

  const out = prediction.output;
  const imageUrl = Array.isArray(out) ? out[0] : out;
  if (typeof imageUrl !== 'string') {
    throw new Error('Unexpected Replicate output shape: ' + JSON.stringify(out));
  }
  const file = await fetch(imageUrl);
  if (!file.ok) throw new Error(`Could not download image: ${file.status}`);

  return {
    buffer: Buffer.from(await file.arrayBuffer()),
    mimeType: file.headers.get('content-type') || 'image/webp'
  };
}

// ---------------------------------------------------------------------------
// 7. Protected routes — only reached after payment settles.
// ---------------------------------------------------------------------------
app.get('/api/v1/generate-image', async (req, res) => {
  const prompt = (req.query.prompt || '').toString().trim();
  if (!prompt) return res.status(400).json({ error: 'Missing prompt' });

  try {
    console.log(`[gen] image: "${prompt}"`);
    const { buffer, mimeType } = await replicateGenerate(prompt);

    let id = null;
    try {
      const stored = await storeImage({ buffer, mimeType, prompt });
      id = stored.id;
      console.log(`[gen] stored ${id}, ${Math.round(buffer.length / 1024)} KB`);
    } catch (storageErr) {
      console.error('[storage] upload failed, serving inline only:', storageErr);
    }

    if (req.query.format === 'binary') {
      res.set('Content-Type', mimeType);
      if (id) res.set('X-Image-Url', `${BASE_URL}/api/v1/image/${id}`);
      return res.send(buffer);
    }

    const payload = {
      success: true, prompt, model: REPLICATE_MODEL, mimeType,
      image: buffer.toString('base64')
    };
    if (id) {
      payload.imageUrl = `/api/v1/image/${id}`;
      payload.absoluteUrl = `${BASE_URL}/api/v1/image/${id}`;
      payload.downloadUrl = `${BASE_URL}/api/v1/image/${id}?download=1`;
      payload.retentionDays = RETENTION_DAYS;
    } else {
      payload.storageWarning = 'Image generated but not persisted; use the inline base64.';
    }
    res.json(payload);
  } catch (err) {
    console.error('[gen] FAILED AFTER PAYMENT:', prompt, err);
    res.status(502).json({
      error: 'Payment settled but image generation failed: ' + err.message, prompt });
  }
});

app.post('/api/v1/pdf-to-markdown', async (req, res) => {
  const { url, pdf, pageMarkers } = req.body || {};
  if (!url && !pdf) {
    return res.status(400).json({ error: 'Provide either a "url" or base64 "pdf" field' });
  }

  try {
    let buffer;
    if (pdf) {
      buffer = Buffer.from(pdf, 'base64');
      if (!buffer.length) throw new Error('The "pdf" field is not valid base64');
      if (buffer.length > PDF_MAX_BYTES) throw new Error('PDF exceeds the 20 MB limit');
    } else {
      console.log(`[pdf] fetching ${url}`);
      buffer = await fetchPdf(url);
    }

    if (buffer.subarray(0, 5).toString('latin1') !== '%PDF-') {
      throw new Error('That does not look like a PDF (missing %PDF- header)');
    }

    const { markdown, pages, title } = await convertPdf(buffer, { pageMarkers: Boolean(pageMarkers) });
    console.log(`[pdf] converted ${pages} pages -> ${markdown.length} chars`);

    const payload = { success: true, pages, characters: markdown.length, markdown };
    if (title) payload.title = title;
    if (!markdown.trim()) {
      payload.note = 'No text layer found. This is likely a scanned PDF and needs OCR.';
    }
    res.json(payload);
  } catch (err) {
    console.error('[pdf] FAILED AFTER PAYMENT:', url || '(uploaded bytes)', err.message);
    res.status(502).json({ error: 'Payment settled but conversion failed: ' + err.message });
  }
});

app.get('/api/v1/gas/preflight', async (req, res) => {
  const horizonMinutes = Math.max(1, Math.min(60, Number(req.query.horizonMinutes) || 5));

  try {
    const s = await gasSnapshot(horizonMinutes);
    res.json({
      success: true,
      chain: 'base-mainnet',
      block: s.currentBlock,
      observedAt: new Date().toISOString(),
      current: {
        baseFeeGwei: round(weiToGwei(s.current)),
        congestion: s.congestion,
        gasUsedRatio: round(s.avgRatio, 3)
      },
      recent: {
        medianGwei: round(weiToGwei(s.median)),
        p10Gwei: round(weiToGwei(s.p10)),
        p90Gwei: round(weiToGwei(s.p90)),
        volatility: round(s.sigma, 5),
        blocks: s.blocksObserved
      },
      forecast: {
        horizonMinutes,
        targetBlock: s.targetBlock,
        centerGwei: round(weiToGwei(s.center)),
        lowGwei: round(weiToGwei(s.low)),
        highGwei: round(weiToGwei(s.high)),
        interval: 0.8,
        method: 'mean-reverting log random walk on realised block volatility'
      },
      disclaimer:
        'Supporting context for transaction timing, not a trade instruction. ' +
        'All inputs are public Base RPC data and reproducible by any caller.'
    });
  } catch (err) {
    console.error('[gas] preflight FAILED AFTER PAYMENT:', err.message);
    res.status(502).json({ error: 'Payment settled but the chain read failed: ' + err.message });
  }
});

app.post('/api/v1/gas/decision', async (req, res) => {
  const { stance, horizonMinutes, maxFeeGwei, note } = req.body || {};

  if (stance !== 'execute' && stance !== 'wait') {
    return res.status(400).json({ error: 'stance must be "execute" or "wait"' });
  }
  const horizon = Math.max(1, Math.min(60, Number(horizonMinutes) || 5));

  try {
    const s = await gasSnapshot(horizon);
    const decisionId = crypto.randomBytes(16).toString('hex');
    const recordedAt = new Date();
    const auditableAt = new Date(recordedAt.getTime() + horizon * 60 * 1000);

    const record = {
      decisionId,
      stance,
      horizonMinutes: horizon,
      maxFeeGwei: typeof maxFeeGwei === 'number' ? maxFeeGwei : null,
      note: typeof note === 'string' ? note.slice(0, 500) : null,
      recordedAt: recordedAt.toISOString(),
      auditableAt: auditableAt.toISOString(),
      startBlock: s.currentBlock,
      targetBlock: s.targetBlock,
      snapshot: {
        baseFeeGwei: round(weiToGwei(s.current)),
        centerGwei: round(weiToGwei(s.center)),
        lowGwei: round(weiToGwei(s.low)),
        highGwei: round(weiToGwei(s.high)),
        congestion: s.congestion,
        volatility: round(s.sigma, 5)
      }
    };

    await storeDecision(decisionId, record);
    console.log(`[gas] decision ${decisionId} stance=${stance} target=${s.targetBlock}`);

    res.json({
      success: true,
      ...record,
      auditUrl: `${BASE_URL}/api/v1/gas/audit/${decisionId}`
    });
  } catch (err) {
    console.error('[gas] decision FAILED AFTER PAYMENT:', err.message);
    res.status(502).json({ error: 'Payment settled but the decision could not be recorded: ' + err.message });
  }
});

app.get('/api/v1/gas/audit/:decisionId', async (req, res) => {
  const id = req.params.decisionId;
  if (!/^[a-f0-9]{32}$/.test(id)) {
    return res.status(400).json({ error: 'Malformed decision id' });
  }

  try {
    const record = await loadDecision(id);
    if (!record) return res.status(404).json({ error: 'Decision not found' });

    const head = Number(BigInt(await rpc('eth_blockNumber')));

    if (head < record.targetBlock) {
      const blocksRemaining = record.targetBlock - head;
      return res.json({
        success: true,
        decisionId: id,
        status: 'pending',
        stance: record.stance,
        targetBlock: record.targetBlock,
        currentBlock: head,
        blocksRemaining,
        secondsRemaining: blocksRemaining * BASE_BLOCK_SECONDS,
        auditableAt: record.auditableAt,
        forecast: {
          lowGwei: record.snapshot.lowGwei,
          centerGwei: record.snapshot.centerGwei,
          highGwei: record.snapshot.highGwei
        }
      });
    }

    const actual = await baseFeeAtBlock(record.targetBlock);
    if (!actual) throw new Error('Target block not retrievable from RPC');

    const actualGwei = round(weiToGwei(actual.baseFee));
    const startGwei = record.snapshot.baseFeeGwei;
    const changePct = startGwei > 0 ? round(((actualGwei - startGwei) / startGwei) * 100, 2) : 0;

    const contained = actualGwei >= record.snapshot.lowGwei && actualGwei <= record.snapshot.highGwei;

    // "Favourable" means the recorded stance turned out cheaper than its
    // opposite. Waiting wins when the fee fell; executing wins when it rose.
    let stanceOutcome = 'neutral';
    if (Math.abs(changePct) >= 1) {
      const waitingWon = changePct < 0;
      stanceOutcome = (record.stance === 'wait') === waitingWon ? 'favourable' : 'unfavourable';
    }

    const direction = changePct < 0 ? 'fell' : changePct > 0 ? 'rose' : 'was flat';
    const explanation =
      `Base fee ${direction} ${Math.abs(changePct)}% over ${record.horizonMinutes} minutes, ` +
      `so ${changePct < 0 ? 'waiting' : 'executing'} was the cheaper choice. ` +
      `The 80% interval ${contained ? 'contained' : 'did not contain'} the observed value.`;

    let withinBudget = null;
    if (record.maxFeeGwei !== null) withinBudget = actualGwei <= record.maxFeeGwei;

    console.log(`[gas] audit ${id} actual=${actualGwei} contained=${contained}`);

    res.json({
      success: true,
      decisionId: id,
      status: 'resolved',
      stance: record.stance,
      recordedAt: record.recordedAt,
      horizonMinutes: record.horizonMinutes,
      forecast: {
        lowGwei: record.snapshot.lowGwei,
        centerGwei: record.snapshot.centerGwei,
        highGwei: record.snapshot.highGwei,
        interval: 0.8
      },
      actual: {
        block: record.targetBlock,
        baseFeeGwei: actualGwei,
        observedAt: new Date(actual.timestamp).toISOString()
      },
      rangeContainedActual: contained,
      changePct,
      stanceOutcome,
      withinBudget,
      explanation,
      verify: `https://basescan.org/block/${record.targetBlock}`
    });
  } catch (err) {
    console.error('[gas] audit FAILED AFTER PAYMENT:', id, err.message);
    res.status(502).json({ error: 'Payment settled but the audit failed: ' + err.message });
  }
});

// ---------------------------------------------------------------------------
// 8. Health and errors
// ---------------------------------------------------------------------------
app.get('/healthz', (req, res) =>
  res.json({
    ok: true,
    protocol: 'x402 v2',
    baseUrl: BASE_URL,
    endpoints: ENDPOINTS.map(e => ({ route: `${e.method} ${e.path}`, price: e.price })),
    facilitator: usingCdp ? 'cdp' : 'payai',
    bazaarEnabled: usingCdp,
    payTo: WALLET_ADDRESS,
    replicate: Boolean(REPLICATE_TOKEN),
    model: REPLICATE_MODEL,
    rpc: BASE_RPC_URL,
    storage: r2Enabled ? 'r2' : 'memory-only',
    bucket: r2Enabled ? R2_BUCKET : null,
    hotCache: hotCache.size,
    decisionsCached: decisionMemory.size
  })
);

app.use((err, req, res, next) => {
  console.error('[x402] middleware error:', err);
  res.status(err.status || 500).json({ error: err.message || String(err) });
});

const PORT = process.env.PORT || 10000;
const facilitatorLabel = usingCdp ? 'CDP (Bazaar on)' : 'PayAI (Bazaar off)';
const storageLabel = r2Enabled ? 'R2' : 'memory-only';
app.listen(PORT, function () {
  console.log('Server on port ' + PORT + ' - facilitator: ' + facilitatorLabel + ', storage: ' + storageLabel);
  console.log('Endpoints: ' + ENDPOINTS.map(e => e.method + ' ' + e.path + ' $' + e.price).join(', '));
});