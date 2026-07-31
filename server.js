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
const PRICE_VIDEO = process.env.PRICE_VIDEO || '1.50';
const PRICE_TRANSCRIBE = process.env.PRICE_TRANSCRIBE || '1.50';

// Model slugs are env-configurable because Replicate's catalogue and pricing
// move. Set these to whatever you have actually checked the price of.
// An official model is "owner/name"; a community model is "owner/name:versionhash".
const REPLICATE_VIDEO_MODEL = process.env.REPLICATE_VIDEO_MODEL || 'prunaai/p-video';
const VIDEO_RESOLUTION = process.env.VIDEO_RESOLUTION || '1080p';
const REPLICATE_AUDIO_MODEL = process.env.REPLICATE_AUDIO_MODEL || 'openai/whisper';

const JOB_TTL_MS = 7 * 24 * 60 * 60 * 1000;   // job records kept a week
const AUDIO_MAX_BYTES = 200 * 1024 * 1024;

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
    method: 'POST',
    path: '/api/v1/video',
    price: PRICE_VIDEO,
    operationId: 'generateVideo',
    summary: 'Generate a short video from a prompt or a starting image',
    tags: ['Media'],
    description:
      'Text-to-video and image-to-video generation at 1080p, up to five seconds. Returns a job id ' +
      'immediately; poll the free ' +
      'status endpoint until it completes, then collect an MP4 stored on a durable URL. ' +
      'Generation typically takes one to three minutes. No API key or account needed.',
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              prompt: { type: 'string', description: 'What the video should show' },
              imageUrl: { type: 'string', description: 'Optional starting frame for image-to-video' },
              durationSeconds: { type: 'integer', minimum: 3, maximum: 5, default: 5 }
            },
            required: ['prompt']
          },
          example: { prompt: 'a paper boat drifting down a rain-filled gutter', durationSeconds: 5 }
        }
      }
    },
    inputExample: { prompt: 'a paper boat drifting down a rain-filled gutter', durationSeconds: 5 },
    inputSchema: {
      properties: {
        prompt: { type: 'string', description: 'What the video should show' },
        imageUrl: { type: 'string', description: 'Optional starting frame for image-to-video' },
        durationSeconds: { type: 'integer', description: 'Clip length in seconds, 3 to 5' }
      },
      required: ['prompt']
    },
    outputExample: {
      success: true, status: 'processing',
      jobId: '3f9a2c1b4d6e8f0a1b2c3d4e5f607182',
      statusUrl: `${BASE_URL}/api/v1/jobs/3f9a2c1b4d6e8f0a1b2c3d4e5f607182`,
      pollAfterSeconds: 20
    },
    outputSchema: {
      properties: {
        success: { type: 'boolean' },
        status: { type: 'string', enum: ['processing'] },
        jobId: { type: 'string' },
        statusUrl: { type: 'string', description: 'Free endpoint; poll until status is completed' },
        pollAfterSeconds: { type: 'number' }
      }
    }
  },
  {
    method: 'POST',
    path: '/api/v1/transcribe',
    price: PRICE_TRANSCRIBE,
    operationId: 'transcribeAudio',
    summary: 'Transcribe audio or video into timestamped text',
    tags: ['Data'],
    description:
      'Speech-to-text with timestamped segments, for recordings an agent cannot listen to ' +
      'directly: podcasts, meetings, earnings calls, lecture audio. Give a public URL to an ' +
      'audio or video file. Returns a job id immediately; poll the free status endpoint for the ' +
      'transcript. Handles files up to several hours. No API key or account needed.',
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              audioUrl: { type: 'string', description: 'Public URL of an audio or video file' },
              language: { type: 'string', description: 'ISO code such as en; omit to auto-detect' },
              translate: { type: 'boolean', description: 'Translate the transcript into English' }
            },
            required: ['audioUrl']
          },
          example: { audioUrl: 'https://example.com/earnings-call.mp3' }
        }
      }
    },
    inputExample: { audioUrl: 'https://example.com/earnings-call.mp3' },
    inputSchema: {
      properties: {
        audioUrl: { type: 'string', description: 'Public URL of an audio or video file' },
        language: { type: 'string', description: 'ISO code such as en; omit to auto-detect' },
        translate: { type: 'boolean', description: 'Translate the transcript into English' }
      },
      required: ['audioUrl']
    },
    outputExample: {
      success: true, status: 'processing',
      jobId: '8c2d1e4f6a9b0c3d5e7f8091a2b3c4d5',
      statusUrl: `${BASE_URL}/api/v1/jobs/8c2d1e4f6a9b0c3d5e7f8091a2b3c4d5`,
      pollAfterSeconds: 15
    },
    outputSchema: {
      properties: {
        success: { type: 'boolean' },
        status: { type: 'string', enum: ['processing'] },
        jobId: { type: 'string' },
        statusUrl: { type: 'string' },
        pollAfterSeconds: { type: 'number' }
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
// Public stats: calls served and the calibration record.
//
// Kept as one small JSON object in R2 rather than by listing decision records,
// because listing and reading every decision on each page load would be slow
// and would burn R2 operations. Held in memory, flushed on a timer.
// ---------------------------------------------------------------------------
const STATS_KEY = 'stats/index.json';
const RECENT_MAX = 40;      // marks shown on the calibration strip
const ERRORS_MAX = 200;     // sample retained for the median error

let stats = {
  since: new Date().toISOString(),
  callsServed: 0,
  byEndpoint: {},
  // Distinct wallet addresses that have paid. Pulled from the EIP-3009
  // authorization, so it is exactly who settled — no inference about whether
  // a given wallet belongs to an agent or a person, because that is not
  // knowable from the chain.
  payers: [],
  // One bucket per UTC day, so the adoption chart can be drawn from real
  // history rather than a projection.
  daily: {},
  calibration: { resolved: 0, contained: 0, absErrors: [], recent: [] }
};
let statsDirty = false;

async function loadStats() {
  if (!r2) return;
  try {
    const result = await r2.send(new GetObjectCommand({ Bucket: R2_BUCKET, Key: STATS_KEY }));
    const text = Buffer.from(await result.Body.transformToByteArray()).toString('utf8');
    const saved = JSON.parse(text);
    stats = {
      since: saved.since || stats.since,
      callsServed: saved.callsServed || 0,
      byEndpoint: saved.byEndpoint || {},
      payers: saved.payers || [],
      daily: saved.daily || {},
      calibration: {
        resolved: saved.calibration?.resolved || 0,
        contained: saved.calibration?.contained || 0,
        absErrors: saved.calibration?.absErrors || [],
        recent: saved.calibration?.recent || []
      }
    };
    console.log(`[stats] loaded: ${stats.callsServed} calls, ${stats.calibration.resolved} forecasts resolved`);
  } catch (err) {
    const notFound = err.name === 'NoSuchKey' ||
      (err.$metadata && err.$metadata.httpStatusCode === 404);
    if (notFound) console.log('[stats] no saved stats yet, starting fresh');
    else console.error('[stats] load failed:', err.name, err.message);
  }
}

async function flushStats() {
  if (!statsDirty || !r2) return;
  statsDirty = false;
  try {
    await r2.send(new PutObjectCommand({
      Bucket: R2_BUCKET, Key: STATS_KEY,
      Body: Buffer.from(JSON.stringify(stats)),
      ContentType: 'application/json'
    }));
  } catch (err) {
    statsDirty = true;                       // retry on the next tick
    console.error('[stats] flush failed:', err.message);
  }
}

const PAYERS_MAX = 5000;
const DAILY_MAX = 3700;    // roughly ten years of daily buckets

function today() {
  return new Date().toISOString().slice(0, 10);
}

function recordCall(route, payer) {
  stats.callsServed += 1;
  stats.byEndpoint[route] = (stats.byEndpoint[route] || 0) + 1;

  let newPayer = false;
  if (payer) {
    const addr = String(payer).toLowerCase();
    if (/^0x[a-f0-9]{40}$/.test(addr) && !stats.payers.includes(addr)) {
      stats.payers.push(addr);
      if (stats.payers.length > PAYERS_MAX) stats.payers.shift();
      newPayer = true;
    }
  }

  const day = today();
  const bucket = stats.daily[day] || { calls: 0, newPayers: 0 };
  bucket.calls += 1;
  if (newPayer) bucket.newPayers += 1;
  stats.daily[day] = bucket;

  const days = Object.keys(stats.daily).sort();
  while (days.length > DAILY_MAX) delete stats.daily[days.shift()];

  statsDirty = true;
}

// Cumulative series from the first day with activity through today, with gaps
// filled so a quiet week reads as flat rather than as missing data.
function buildSeries() {
  const days = Object.keys(stats.daily).sort();
  if (!days.length) return [];

  const start = new Date(days[0] + 'T00:00:00Z');
  const end = new Date(today() + 'T00:00:00Z');
  const out = [];
  let calls = 0;
  let payers = 0;

  for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    const key = d.toISOString().slice(0, 10);
    const b = stats.daily[key];
    if (b) { calls += b.calls; payers += b.newPayers; }
    out.push({ date: key, calls, payers });
  }
  return out;
}

function recordAudit({ held, changePct }) {
  stats.calibration.resolved += 1;
  if (held) stats.calibration.contained += 1;
  stats.calibration.absErrors.push(Math.abs(Number(changePct) || 0));
  if (stats.calibration.absErrors.length > ERRORS_MAX) stats.calibration.absErrors.shift();
  stats.calibration.recent.push({ held: Boolean(held), changePct: Number(changePct) || 0 });
  if (stats.calibration.recent.length > RECENT_MAX) stats.calibration.recent.shift();
  statsDirty = true;
}

function medianOf(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

await loadStats();
setInterval(flushStats, 15000).unref();
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, async () => { await flushStats(); process.exit(0); });
}

// ---------------------------------------------------------------------------
// Long-running jobs.
//
// Video and transcription take minutes, which is far longer than any HTTP
// client — or agent — will hold a connection. So the paid call starts the work
// and returns a job id immediately; a free status endpoint reports progress.
//
// Progress is checked lazily, when someone asks, rather than by a background
// worker. On a single instance that is simpler and cannot drift.
// ---------------------------------------------------------------------------
const jobMemory = new Map();

async function storeJob(job) {
  job.updatedAt = new Date().toISOString();
  jobMemory.set(job.id, job);
  if (!r2) return;
  try {
    await r2.send(new PutObjectCommand({
      Bucket: R2_BUCKET, Key: `jobs/${job.id}.json`,
      Body: Buffer.from(JSON.stringify(job)), ContentType: 'application/json'
    }));
  } catch (err) {
    console.error('[jobs] write failed:', err.message);
  }
}

async function loadJob(id) {
  if (jobMemory.has(id)) return jobMemory.get(id);
  if (!r2) return null;
  try {
    const result = await r2.send(new GetObjectCommand({ Bucket: R2_BUCKET, Key: `jobs/${id}.json` }));
    const job = JSON.parse(Buffer.from(await result.Body.transformToByteArray()).toString('utf8'));
    jobMemory.set(id, job);
    return job;
  } catch (err) {
    return null;
  }
}

// Generic asset store. Unlike the image store this records the content type on
// the object itself, so retrieval needs no extension guessing.
async function storeAsset(buffer, contentType) {
  const id = crypto.randomBytes(16).toString('hex');
  if (r2) {
    await r2.send(new PutObjectCommand({
      Bucket: R2_BUCKET, Key: `assets/${id}`, Body: buffer, ContentType: contentType
    }));
  } else {
    hotSet('asset:' + id, { buffer, mimeType: contentType, prompt: 'asset' });
  }
  return id;
}

async function loadAsset(id) {
  const hot = hotCache.get('asset:' + id);
  if (hot) return hot;
  if (!r2) return null;
  try {
    const result = await r2.send(new GetObjectCommand({ Bucket: R2_BUCKET, Key: `assets/${id}` }));
    return {
      buffer: Buffer.from(await result.Body.transformToByteArray()),
      mimeType: result.ContentType || 'application/octet-stream'
    };
  } catch (err) {
    return null;
  }
}

// Replicate accepts two different shapes: official models are addressed by
// name, community models by version hash. Support both so the model slug can
// be swapped by env var without a code change.
async function replicateStart(model, input) {
  if (!REPLICATE_TOKEN) throw new Error('REPLICATE_API_TOKEN is not set on the server');
  const headers = {
    Authorization: `Bearer ${REPLICATE_TOKEN}`,
    'Content-Type': 'application/json'
  };

  const isVersioned = model.includes(':');
  const url = isVersioned
    ? 'https://api.replicate.com/v1/predictions'
    : `https://api.replicate.com/v1/models/${model}/predictions`;
  const body = isVersioned
    ? { version: model.split(':')[1], input }
    : { input };

  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`Replicate ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

async function replicateGet(predictionId) {
  const res = await fetch(`https://api.replicate.com/v1/predictions/${predictionId}`, {
    headers: { Authorization: `Bearer ${REPLICATE_TOKEN}` }
  });
  if (!res.ok) throw new Error(`Replicate poll ${res.status}`);
  return res.json();
}

function firstUrl(output) {
  if (typeof output === 'string') return output;
  if (Array.isArray(output)) return output.find(o => typeof o === 'string') || null;
  if (output && typeof output === 'object') {
    for (const k of ['video', 'url', 'output', 'mp4']) {
      if (typeof output[k] === 'string') return output[k];
    }
  }
  return null;
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
// ---------------------------------------------------------------------------
// Site icon. Embedded rather than served from disk so there is no asset to
// deploy. SVG for modern browsers, PNG for crawlers and directory listings
// that still expect /favicon.ico to be a bitmap.
// ---------------------------------------------------------------------------
const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64">
  <rect width="64" height="64" rx="12" fill="#08111C"/>
  <g fill="#E8A33D">
    <path d="M32 11 C41.5 24 41.5 38 32 49 C22.5 38 22.5 24 32 11 Z"/>
    <path d="M29.5 49.5 C18 46 9 36.5 7 23.5 C19.5 25 27.5 35 29.5 49.5 Z"/>
    <path d="M34.5 49.5 C46 46 55 36.5 57 23.5 C44.5 25 36.5 35 34.5 49.5 Z"/>
  </g>
</svg>`;
const FAVICON_PNG = Buffer.from('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', 'base64');
const APPLE_ICON = Buffer.from('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', 'base64');

function sendIcon(res, body, type) {
  res.set('Content-Type', type);
  res.set('Cache-Control', 'public, max-age=604800');
  res.send(body);
}

app.get('/favicon.svg', (req, res) => sendIcon(res, FAVICON_SVG, 'image/svg+xml'));
app.get('/favicon.ico', (req, res) => sendIcon(res, FAVICON_PNG, 'image/png'));
app.get('/favicon.png', (req, res) => sendIcon(res, FAVICON_PNG, 'image/png'));
app.get('/apple-touch-icon.png', (req, res) => sendIcon(res, APPLE_ICON, 'image/png'));
app.get('/apple-touch-icon-precomposed.png', (req, res) => sendIcon(res, APPLE_ICON, 'image/png'));

app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Lotus Network — metered services on Base</title>
      <meta name="description" content="Five pay-per-call services on Base, settled in USDC over x402. No key, no account, no subscription.">
      <link rel="icon" href="/favicon.svg" type="image/svg+xml">
      <link rel="alternate icon" href="/favicon.ico" sizes="any">
      <link rel="apple-touch-icon" href="/apple-touch-icon.png">
      <meta name="theme-color" content="#08111C">
      <link rel="preconnect" href="https://fonts.googleapis.com">
      <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
      <link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap" rel="stylesheet">
      <style>
        :root{
          --ink:#08111C; --panel:#0E1A27; --rule:#1C3145;
          --bone:#EAE5D9; --dim:#7F94A8; --faint:#4A6076;
          --amber:#E8A33D; --teal:#6FC3B8; --red:#E2685C;
          --mono:'IBM Plex Mono',ui-monospace,Menlo,monospace;
          --sans:'Space Grotesk',-apple-system,BlinkMacSystemFont,sans-serif;
        }
        *{box-sizing:border-box}
        html{scroll-behavior:smooth}
        body{margin:0;background:var(--ink);color:var(--bone);font-family:var(--sans);
          font-size:15px;line-height:1.6;-webkit-font-smoothing:antialiased}

        .pulse{border-bottom:1px solid var(--rule);background:var(--panel);
          position:sticky;top:0;z-index:20}
        .pulse-in{max-width:1120px;margin:0 auto;padding:0 32px;display:flex;
          overflow-x:auto;scrollbar-width:none}
        .pulse-in::-webkit-scrollbar{display:none}
        .tk{display:flex;align-items:baseline;gap:9px;padding:11px 20px;
          border-right:1px solid var(--rule);white-space:nowrap;font-family:var(--mono)}
        .tk:first-child{padding-left:0} .tk:last-child{border-right:none}
        .tk .l{color:var(--faint);font-size:10px;letter-spacing:.16em;text-transform:uppercase}
        .tk .v{color:var(--bone);font-size:12.5px;font-weight:500;font-variant-numeric:tabular-nums}
        .tk .v.a{color:var(--amber)} .tk .v.t{color:var(--teal)}
        .tk .u{color:var(--faint);font-size:10px;margin-left:2px}
        .dot{width:5px;height:5px;border-radius:50%;background:var(--teal);display:inline-block;
          box-shadow:0 0 7px var(--teal);animation:br 2.8s ease-in-out infinite;flex:none}
        @keyframes br{0%,100%{opacity:1}50%{opacity:.3}}

        .wrap{max-width:1120px;margin:0 auto;padding:0 32px}
        .cols{display:grid;grid-template-columns:236px 1fr;gap:72px;align-items:start}
        .rail{position:sticky;top:80px;padding:56px 0 0}
        .main{padding:56px 0 40px;min-width:0}

        .brand{font-family:var(--mono);font-size:12px;letter-spacing:.22em;text-transform:uppercase;
          color:var(--bone);font-weight:600;margin-bottom:6px}
        .brand-sub{font-family:var(--mono);font-size:10.5px;letter-spacing:.12em;
          color:var(--faint);text-transform:uppercase;margin-bottom:30px}
        .rs{padding:13px 0;border-top:1px solid var(--rule)}
        .rs .l{font-family:var(--mono);font-size:9.5px;letter-spacing:.16em;text-transform:uppercase;
          color:var(--faint);margin-bottom:4px}
        .rs .v{font-family:var(--mono);font-size:17px;font-variant-numeric:tabular-nums;
          color:var(--bone);font-weight:500}
        .rs .v.t{color:var(--teal)} .rs .v small{font-size:11px;color:var(--faint)}
        .rail-nav{margin-top:30px;border-top:1px solid var(--rule);padding-top:18px;
          display:flex;flex-direction:column;gap:9px}
        .rail-nav a{font-family:var(--mono);font-size:11.5px;letter-spacing:.08em;
          color:var(--dim);text-decoration:none;transition:color .15s}
        .rail-nav a:hover{color:var(--amber)}

        .eyebrow{font-family:var(--mono);font-size:10.5px;letter-spacing:.24em;
          text-transform:uppercase;color:var(--amber);margin-bottom:22px}
        h1{font-size:clamp(38px,5.2vw,60px);line-height:1.02;letter-spacing:-.033em;
          font-weight:700;margin:0 0 24px;max-width:14ch}
        h1 em{font-style:normal;color:var(--amber)}
        .lede{font-size:17px;color:var(--dim);max-width:52ch;margin:0 0 34px;line-height:1.62}
        .lede b{color:var(--bone);font-weight:500}
        .cta{display:flex;gap:12px;flex-wrap:wrap}
        .btn{font-family:var(--mono);font-size:12px;letter-spacing:.13em;text-transform:uppercase;
          padding:13px 22px;text-decoration:none;font-weight:500;transition:.15s;
          border:1px solid;cursor:pointer;display:inline-block}
        .btn.p{background:var(--amber);color:var(--ink);border-color:var(--amber);font-weight:600}
        .btn.p:hover{filter:brightness(1.1)}
        .btn.s{background:transparent;color:var(--bone);border-color:var(--rule)}
        .btn.s:hover{border-color:var(--amber);color:var(--amber)}

        section{padding:60px 0;border-top:1px solid var(--rule);margin-top:60px}
        .sl{display:flex;align-items:baseline;gap:14px;margin-bottom:12px;flex-wrap:wrap}
        .sl .n{font-family:var(--mono);font-size:11px;color:var(--faint);letter-spacing:.1em}
        .sl h2{font-size:25px;font-weight:700;letter-spacing:-.018em;margin:0}
        .sl .r{margin-left:auto;font-family:var(--mono);font-size:10.5px;letter-spacing:.14em;
          text-transform:uppercase;color:var(--faint)}
        .sd{color:var(--dim);font-size:14.5px;max-width:60ch;margin:0 0 30px}

        .rate{border:1px solid var(--rule)}
        .row{display:grid;grid-template-columns:52px 1fr auto;gap:18px;align-items:baseline;
          padding:17px 20px;border-bottom:1px solid var(--rule);transition:background .14s;
          cursor:pointer;position:relative}
        .row:last-child{border-bottom:none}
        .row:hover{background:var(--panel)}
        .row.on{background:var(--panel);box-shadow:inset 2px 0 0 var(--amber)}
        .meth{font-family:var(--mono);font-size:9.5px;letter-spacing:.1em;color:var(--faint);
          border:1px solid var(--rule);padding:2px 0;text-align:center}
        .row.on .meth{color:var(--amber);border-color:var(--amber)}
        .row .nm{font-weight:500;font-size:15.5px}
        .row .pr{font-family:var(--mono);font-size:14px;color:var(--amber);
          font-variant-numeric:tabular-nums;font-weight:500}
        .row .ds{grid-column:2/-1;font-size:13.5px;color:var(--dim);margin-top:4px;line-height:1.55}
        .row .pt{grid-column:2/-1;font-family:var(--mono);font-size:11px;color:var(--faint);margin-top:7px}

        .code{border:1px solid var(--rule);background:var(--panel);margin-top:18px}
        .code-h{display:flex;align-items:center;padding:10px 16px;border-bottom:1px solid var(--rule);
          font-family:var(--mono);font-size:10.5px;letter-spacing:.14em;text-transform:uppercase;
          color:var(--faint)}
        .code-h button{margin-left:auto;background:transparent;border:1px solid var(--rule);
          color:var(--dim);font-family:var(--mono);font-size:10px;letter-spacing:.12em;
          text-transform:uppercase;padding:5px 11px;cursor:pointer;transition:.14s}
        .code-h button:hover{border-color:var(--amber);color:var(--amber)}
        pre{margin:0;padding:17px 16px;overflow-x:auto;font-family:var(--mono);font-size:12.5px;
          line-height:1.75;color:var(--dim)}
        pre .c{color:var(--faint)} pre .k{color:var(--amber)} pre .s{color:var(--teal)}
        pre .w{color:var(--bone)}

        .steps{display:grid;grid-template-columns:repeat(3,1fr);gap:1px;background:var(--rule);
          border:1px solid var(--rule);margin-bottom:8px}
        .step{background:var(--ink);padding:22px 20px}
        .step .i{font-family:var(--mono);font-size:10.5px;color:var(--amber);
          letter-spacing:.14em;margin-bottom:11px}
        .step h3{font-size:15.5px;margin:0 0 7px;font-weight:500}
        .step p{font-size:13px;color:var(--dim);margin:0;line-height:1.6}

        .cal{display:grid;grid-template-columns:auto 1fr;gap:36px;align-items:center;margin-bottom:30px}
        .big{font-size:78px;line-height:.9;color:var(--teal);font-weight:700;
          letter-spacing:-.045em;font-variant-numeric:tabular-nums}
        .big span{font-size:30px;color:var(--faint);margin-left:2px}
        .cal p{margin:0;font-size:14.5px;color:var(--dim);max-width:46ch;line-height:1.65}
        .cal p b{color:var(--bone);font-weight:500}
        .strip{display:flex;gap:3px;height:46px;align-items:flex-end;margin-bottom:12px}
        .m{flex:1;border-radius:1px}
        .m.h{background:rgba(111,195,184,.26);border-top:2px solid var(--teal);height:100%}
        .m.x{background:rgba(226,104,92,.2);border-top:2px solid var(--red);height:58%}
        .key{display:flex;gap:22px;font-family:var(--mono);font-size:10px;letter-spacing:.12em;
          text-transform:uppercase;color:var(--faint)}
        .key i{width:9px;height:2px;display:inline-block;margin-right:6px;vertical-align:3px}
        .key .h i{background:var(--teal)} .key .x i{background:var(--red)}
        .g4{display:grid;grid-template-columns:repeat(4,1fr);gap:1px;background:var(--rule);
          border:1px solid var(--rule);margin-top:30px}
        .c4{background:var(--ink);padding:18px}
        .c4 .l{font-family:var(--mono);font-size:9.5px;letter-spacing:.15em;text-transform:uppercase;
          color:var(--faint);margin-bottom:7px}
        .c4 .v{font-family:var(--mono);font-size:23px;font-variant-numeric:tabular-nums;font-weight:500}
        .c4 .v small{font-size:12px;color:var(--faint);margin-left:2px}
        .vf{margin-top:20px;font-size:13px;color:var(--dim);line-height:1.7}
        .vf a{color:var(--teal);text-decoration:none;border-bottom:1px solid rgba(111,195,184,.3)}

        .chart-wrap{border:1px solid var(--rule);background:var(--panel);padding:22px}
        .chart-h{display:flex;justify-content:space-between;align-items:baseline;
          font-family:var(--mono);font-size:10.5px;letter-spacing:.14em;text-transform:uppercase;
          color:var(--faint);margin-bottom:18px;gap:14px;flex-wrap:wrap}
        .chart-legend{display:flex;gap:16px}
        .chart-legend span i{width:9px;height:2px;display:inline-block;margin-right:6px;vertical-align:3px}
        .lg-p i{background:var(--teal)} .lg-c i{background:var(--amber)}
        svg.chart{width:100%;height:180px;display:block;overflow:visible}
        .chart-empty{color:var(--dim);font-size:13.5px;line-height:1.7;padding:26px 0}

        .band-wrap{border:1px solid var(--rule);padding:24px;margin-top:20px;background:var(--panel)}
        .band-h{display:flex;justify-content:space-between;font-family:var(--mono);font-size:10.5px;
          letter-spacing:.14em;text-transform:uppercase;color:var(--faint);margin-bottom:24px;gap:12px}
        .band-h .vd.held{color:var(--teal)} .band-h .vd.missed{color:var(--red)}
        .band{position:relative;height:70px}
        .ax{position:absolute;top:34px;left:0;right:0;height:1px;background:var(--rule)}
        .rg{position:absolute;top:25px;height:19px;background:rgba(232,163,61,.14);
          border-left:1px solid var(--amber);border-right:1px solid var(--amber)}
        .nd{position:absolute;top:18px;width:1px;height:33px;background:var(--amber)}
        .nd::after{content:'';position:absolute;top:-4px;left:-3.5px;width:8px;height:8px;
          background:var(--amber);transform:rotate(45deg)}
        .ac{position:absolute;top:18px;width:1px;height:33px;background:var(--teal)}
        .ac::after{content:'';position:absolute;top:-4px;left:-3.5px;width:8px;height:8px;
          border-radius:50%;background:var(--teal)}
        .ac.missed{background:var(--red)} .ac.missed::after{background:var(--red)}
        .tg{position:absolute;font-family:var(--mono);font-size:10px;color:var(--faint);
          white-space:nowrap;transform:translateX(-50%)}
        .tg.up{top:2px} .tg.dn{top:54px}
        .tg.a{color:var(--amber)} .tg.t{color:var(--teal)} .tg.r{color:var(--red)}

        label.cap{display:block;font-family:var(--mono);font-size:10px;letter-spacing:.16em;
          text-transform:uppercase;color:var(--faint);margin-bottom:8px}
        input[type=text],input[type=number],select{width:100%;padding:13px 14px;background:var(--ink);
          color:var(--bone);border:1px solid var(--rule);border-radius:0;font-family:var(--mono);
          font-size:14px}
        input:focus,select:focus{outline:none;border-color:var(--amber)}
        input[type=file]{color:var(--dim);font-family:var(--mono);font-size:12px;width:100%}
        input[type=file]::file-selector-button{background:transparent;color:var(--bone);
          border:1px solid var(--rule);padding:9px 13px;margin-right:12px;font-family:var(--mono);
          font-size:11px;cursor:pointer}
        .field{margin-bottom:18px}
        .hint{font-family:var(--mono);font-size:11px;color:var(--faint);margin-top:8px}
        .run{width:100%;display:flex;justify-content:space-between;align-items:center;
          padding:16px 18px;background:var(--amber);color:var(--ink);border:none;cursor:pointer;
          font-family:var(--mono);font-weight:600;font-size:12.5px;letter-spacing:.14em;
          text-transform:uppercase;transition:filter .14s}
        .run:hover:not(:disabled){filter:brightness(1.1)}
        .run:disabled{background:var(--rule);color:var(--faint);cursor:wait}
        .ladder{margin-top:22px;display:none}
        .ladder.show{display:block}
        .rung{display:grid;grid-template-columns:22px 1fr auto;gap:12px;align-items:center;
          padding:7px 0;font-family:var(--mono);font-size:11.5px;color:var(--rule);transition:color .2s}
        .rung .tr{height:1px;background:var(--rule);transition:background .2s}
        .rung .st{font-size:10px;letter-spacing:.16em;text-transform:uppercase}
        .rung.active{color:var(--amber)} .rung.active .tr{background:var(--amber)}
        .rung.done{color:var(--teal)} .rung.done .tr{background:var(--teal)}
        .rung.failed{color:var(--red)} .rung.failed .tr{background:var(--red)}
        .fail{margin-top:18px;padding:14px 16px;border-left:2px solid var(--red);
          background:rgba(226,104,92,.06);font-size:13px;white-space:pre-wrap;
          word-break:break-word;display:none;font-family:var(--mono);line-height:1.6}
        .fail.show{display:block}
        .out{display:none;margin-top:26px}
        .out.show{display:block}
        .out img{width:100%;display:block;border:1px solid var(--rule)}
        pre.data{margin:0;padding:17px;background:var(--panel);border:1px solid var(--rule);
          font-size:12px;line-height:1.7;color:var(--dim);max-height:340px;overflow:auto;
          white-space:pre-wrap;word-break:break-word}
        .acts{display:flex;gap:1px;margin-top:1px}
        .acts button{flex:1;padding:13px 8px;background:var(--panel);color:var(--bone);
          border:1px solid var(--rule);cursor:pointer;font-family:var(--mono);font-size:10.5px;
          letter-spacing:.13em;text-transform:uppercase}
        .acts button:hover{border-color:var(--amber);color:var(--amber)}
        .meta{margin-top:16px;font-family:var(--mono);font-size:11.5px;color:var(--faint);
          line-height:1.75;word-break:break-all}
        .meta a{color:var(--teal);text-decoration:none}
        .toast{margin-top:10px;font-family:var(--mono);font-size:11.5px;color:var(--teal);min-height:1.2em}
        .toast.bad{color:var(--red)}
        .empty{color:var(--dim);font-size:13.5px;line-height:1.7}

        footer{border-top:1px solid var(--rule);padding:34px 0 60px;display:flex;gap:28px;
          flex-wrap:wrap;font-family:var(--mono);font-size:11px;letter-spacing:.1em;
          text-transform:uppercase;color:var(--faint)}
        footer a{color:var(--faint);text-decoration:none}
        footer a:hover{color:var(--amber)}
        .hidden{display:none!important}

        @media(max-width:960px){
          .cols{grid-template-columns:1fr;gap:0}
          .rail{position:static;padding:34px 0 0;display:grid;grid-template-columns:repeat(2,1fr);gap:0 28px}
          .rail .brand,.rail .brand-sub,.rail-nav{grid-column:1/-1}
          .main{padding-top:38px}
          .steps{grid-template-columns:1fr}
          .g4{grid-template-columns:repeat(2,1fr)}
          .cal{grid-template-columns:1fr;gap:18px}
          .wrap{padding:0 22px}
        }
        @media(prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}
      </style>
    </head>
    <body>

    <div class="pulse"><div class="pulse-in">
      <div class="tk"><span class="dot"></span><span class="l">Base gas</span><span class="v a" id="t_gas">—</span></div>
      <div class="tk"><span class="l">Block</span><span class="v" id="t_block">—</span></div>
      <div class="tk"><span class="l">Congestion</span><span class="v t" id="t_cong">—</span></div>
      <div class="tk"><span class="l">Calls served</span><span class="v" id="t_calls">—</span></div>
      <div class="tk"><span class="l">Paying wallets</span><span class="v" id="t_payers">—</span></div>
      <div class="tk hidden" id="t_eco_wrap"><span class="l">x402 endpoints</span><span class="v" id="t_eco">—</span></div>
    </div></div>

    <div class="wrap"><div class="cols">

      <aside class="rail">
        <div class="brand">Lotus Network</div>
        <div class="brand-sub">Base mainnet · x402 v2</div>
        <div class="rs"><div class="l">Services</div><div class="v" id="r_svc">5</div></div>
        <div class="rs"><div class="l">Calls served</div><div class="v" id="r_calls">—</div></div>
        <div class="rs"><div class="l">Interval held</div><div class="v t" id="r_hit">—</div></div>
        <div class="rs"><div class="l">From</div><div class="v">$${PRICE_PREFLIGHT}</div></div>
        <nav class="rail-nav">
          <a href="#services">Services</a>
          <a href="#record">Calibration record</a>
          <a href="#adoption">Adoption</a>
          <a href="#try">Try it</a>
          <a href="/openapi.json">OpenAPI ↗</a>
          <a href="/llms.txt">llms.txt ↗</a>
        </nav>
      </aside>

      <main class="main">
        <div class="eyebrow">Metered access · no accounts</div>
        <h1>Seven services.<br>Priced <em>per call</em>.</h1>
        <p class="lede">Settled in USDC on Base over the x402 protocol. <b>No key, no account,
          no subscription</b> — a wallet is asked once per request, and the receipt is on-chain.
          Built for agents; usable by anyone with a browser wallet.</p>
        <div class="cta">
          <a href="#services" class="btn p">See the services</a>
          <a href="#record" class="btn s">See the record</a>
        </div>

        <section id="services">
          <div class="sl"><span class="n">01</span><h2>Services</h2><span class="r">USDC · eip155:8453</span></div>
          <p class="sd">Every endpoint answers HTTP 402 with its terms. Pay, retry, get the result.
            Selecting a row here also selects it in the panel below.</p>
          <div class="rate" id="rateCard">
            <div class="row on" data-mode="video">
              <span class="meth">POST</span><span class="nm">Video generation</span><span class="pr">$${PRICE_VIDEO}</span>
              <span class="ds">Text-to-video or image-to-video at 1080p. Returns a job id; the MP4 lands on a durable URL.</span>
              <span class="pt">/api/v1/video</span>
            </div>
            <div class="row" data-mode="image">
              <span class="meth">GET</span><span class="nm">Image generation</span><span class="pr">$${PRICE_IMAGE}</span>
              <span class="ds">FLUX text-to-image. Returns the bytes plus a durable URL.</span>
              <span class="pt">/api/v1/generate-image</span>
            </div>
            <div class="row" data-mode="transcribe">
              <span class="meth">POST</span><span class="nm">Transcription</span><span class="pr">$${PRICE_TRANSCRIBE}</span>
              <span class="ds">Audio or video to timestamped text. Podcasts, meetings, earnings calls.</span>
              <span class="pt">/api/v1/transcribe</span>
            </div>
            <div class="row" data-mode="pdf">
              <span class="meth">POST</span><span class="nm">PDF to Markdown</span><span class="pr">$${PRICE_PDF}</span>
              <span class="ds">Text-layer extraction, unwrapped into clean Markdown with headings and lists.</span>
              <span class="pt">/api/v1/pdf-to-markdown</span>
            </div>
            <div class="row" data-mode="preflight">
              <span class="meth">GET</span><span class="nm">Gas preflight</span><span class="pr">$${PRICE_PREFLIGHT}</span>
              <span class="ds">Current Base fee, recent percentiles, realised volatility, and an 80% forecast range.</span>
              <span class="pt">/api/v1/gas/preflight</span>
            </div>
            <div class="row" data-mode="decision">
              <span class="meth">POST</span><span class="nm">Gas decision</span><span class="pr">$${PRICE_DECISION}</span>
              <span class="ds">Journals an execute-or-wait call against the snapshot. Returns a decision_id.</span>
              <span class="pt">/api/v1/gas/decision</span>
            </div>
            <div class="row" data-mode="audit">
              <span class="meth">GET</span><span class="nm">Gas audit</span><span class="pr">$${PRICE_AUDIT}</span>
              <span class="ds">Checks that decision_id against what the chain actually did at the target block.</span>
              <span class="pt">/api/v1/gas/audit/{id}</span>
            </div>
          </div>
        </section>

        <section id="record">
          <div class="sl"><span class="n">02</span><h2>Calibration record</h2><span class="r" id="calScope"></span></div>
          <p class="sd">Anyone can publish a forecast. This is the part that can be checked: every
            journalled decision is resolved against the base fee at its target block, and the
            misses are published alongside the hits.</p>
          <div id="calBody"><div class="empty">Loading the record…</div></div>
        </section>

        <section id="adoption">
          <div class="sl"><span class="n">03</span><h2>Adoption</h2><span class="r" id="adScope"></span></div>
          <p class="sd">Cumulative calls and distinct paying wallets, one point per day since the
            first payment. These are wallets that settled, not a count of agents — nothing
            on-chain distinguishes an autonomous agent from a person holding a wallet.</p>
          <div class="chart-wrap">
            <div class="chart-h">
              <span id="adRange">—</span>
              <span class="chart-legend">
                <span class="lg-p"><i></i>Paying wallets</span>
                <span class="lg-c"><i></i>Calls</span>
              </span>
            </div>
            <div id="chartHost"><div class="chart-empty">No payments recorded yet. The series
              starts on the first settled call and extends a point per day from there.</div></div>
          </div>
        </section>

        <section id="try">
          <div class="sl"><span class="n">04</span><h2>Try it</h2></div>
          <p class="sd">Runs against the live API from your browser wallet. Real USDC, real
            settlement — the smallest call costs $${PRICE_PREFLIGHT}.</p>

          <div id="f_image" class="hidden">
            <div class="field"><label class="cap" for="prompt">Prompt</label>
              <input type="text" id="prompt" placeholder="a harbour crane at dawn, long exposure"></div>
          </div>
          <div id="f_pdf" class="hidden">
            <div class="field"><label class="cap" for="pdfUrl">PDF address</label>
              <input type="text" id="pdfUrl" placeholder="https://example.com/report.pdf"></div>
            <div class="field"><label class="cap" for="pdfFile">Or send a file</label>
              <input type="file" id="pdfFile" accept="application/pdf">
              <div class="hint">20 MB ceiling. Scanned PDFs carry no text layer and return empty.</div></div>
          </div>
          <div id="f_video">
            <div class="field"><label class="cap" for="vPrompt">Prompt</label>
              <input type="text" id="vPrompt" placeholder="a paper boat drifting down a rain-filled gutter"></div>
            <div class="field"><label class="cap" for="vImage">Starting image URL — optional</label>
              <input type="text" id="vImage" placeholder="https://example.com/frame.jpg"></div>
            <div class="field"><label class="cap" for="vDur">Duration · seconds</label>
              <input type="number" id="vDur" value="5" min="3" max="5">
              <div class="hint">Runs as a background job. Usually one to three minutes.</div></div>
          </div>
          <div id="f_transcribe" class="hidden">
            <div class="field"><label class="cap" for="aUrl">Audio or video URL</label>
              <input type="text" id="aUrl" placeholder="https://example.com/earnings-call.mp3"></div>
            <div class="field"><label class="cap" for="aLang">Language — optional</label>
              <input type="text" id="aLang" placeholder="en · leave blank to auto-detect">
              <div class="hint">200 MB ceiling. Roughly one minute of processing per hour of audio.</div></div>
          </div>
          <div id="f_preflight" class="hidden">
            <div class="field"><label class="cap" for="horizon1">Horizon · minutes</label>
              <input type="number" id="horizon1" value="5" min="1" max="60"></div>
          </div>
          <div id="f_decision" class="hidden">
            <div class="field"><label class="cap" for="stance">Stance</label>
              <select id="stance">
                <option value="wait">wait — hold, expecting cheaper gas</option>
                <option value="execute">execute — transact now</option>
              </select></div>
            <div class="field"><label class="cap" for="horizon2">Horizon · minutes</label>
              <input type="number" id="horizon2" value="15" min="1" max="60">
              <div class="hint">Keep the ID it returns. The audit needs it once the horizon elapses.</div></div>
          </div>
          <div id="f_audit" class="hidden">
            <div class="field"><label class="cap" for="decisionId">Decision ID</label>
              <input type="text" id="decisionId" placeholder="32 hex characters">
              <div class="hint">Returns pending until the target block is reached.</div></div>
          </div>

          <button class="run" id="btn" onclick="run()">
            <span>Run</span><span id="btnAmt">$${PRICE_VIDEO}</span></button>

          <div class="ladder" id="ladder">
            <div class="rung" data-step="1"><span>1</span><span class="tr"></span><span class="st">Read terms</span></div>
            <div class="rung" data-step="2"><span>2</span><span class="tr"></span><span class="st">Connect wallet</span></div>
            <div class="rung" data-step="3"><span>3</span><span class="tr"></span><span class="st">Sign authorization</span></div>
            <div class="rung" data-step="4"><span>4</span><span class="tr"></span><span class="st">Settle on Base</span></div>
            <div class="rung" data-step="5"><span>5</span><span class="tr"></span><span class="st">Deliver</span></div>
          </div>

          <div class="fail" id="fail"></div>

          <div class="out" id="out">
            <div class="band-wrap hidden" id="meter">
              <div class="band-h"><span id="meterTitle">Fee band · gwei</span>
                <span class="vd" id="meterVerdict"></span></div>
              <div class="band" id="band"></div>
            </div>
            <img id="image" alt="" class="hidden">
            <video id="video" class="hidden" controls playsinline
              style="width:100%;display:block;border:1px solid var(--rule);background:#000"></video>
            <div id="jobBox" class="hidden"></div>
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
        </section>

        <footer>
          <a href="/openapi.json">OpenAPI</a>
          <a href="/llms.txt">llms.txt</a>
          <a href="/api/v1/pulse">Pulse</a>
          <a href="/healthz">Status</a>
          <span>USDC · Base · eip155:8453</span>
        </footer>
      </main>

    </div></div>

    <script>
      const PRICE={image:'${PRICE_IMAGE}',pdf:'${PRICE_PDF}',preflight:'${PRICE_PREFLIGHT}',
        decision:'${PRICE_DECISION}',audit:'${PRICE_AUDIT}'};
      const MODES=['image','pdf','video','transcribe','preflight','decision','audit'];

      // Jobs run in the background. Poll the free status endpoint until it
      // resolves, showing elapsed time so a long wait doesn't look like a hang.
      let jobTimer=null;
      function stopPolling(){if(jobTimer){clearTimeout(jobTimer);jobTimer=null;}}

      function jobLine(label,extra){
        return '<div style="border:1px solid var(--rule);background:var(--panel);padding:16px;'+
          'font-family:var(--mono);font-size:12.5px;line-height:1.7">'+label+
          (extra?'<div style="color:var(--faint);margin-top:6px">'+extra+'</div>':'')+'</div>';
      }

      async function pollJob(jobId,kind,startedAt){
        const box=$('jobBox');
        box.classList.remove('hidden');
        try{
          const r=await fetch('/api/v1/jobs/'+jobId);
          const j=await r.json();
          const secs=Math.round((Date.now()-startedAt)/1000);

          if(j.status==='processing'){
            box.innerHTML=jobLine(
              '<span style="color:var(--amber)">Working…</span> '+secs+'s elapsed',
              'Job '+jobId+' · polling is free · this page will update itself');
            jobTimer=setTimeout(()=>pollJob(jobId,kind,startedAt),(j.pollAfterSeconds||15)*1000);
            return;
          }

          if(j.status==='failed'){
            box.innerHTML=jobLine('<span style="color:var(--red)">Job failed.</span> '+
              (j.error||''),'You were charged. Quote job '+jobId+' for a credit.');
            return;
          }

          // completed
          if(kind==='video'){
            const v=$('video');
            v.src=j.result.videoUrl;v.classList.remove('hidden');
            lastResult={absoluteUrl:j.result.videoUrl,prompt:'video'};
            box.innerHTML=jobLine('<span style="color:var(--teal)">Done</span> in '+secs+'s',
              Math.round(j.result.sizeBytes/1024)+' KB · '+j.result.model);
            $('textActs').classList.add('hidden');
            $('imageActs').classList.add('hidden');
            $('meta').innerHTML='<a href="'+j.result.videoUrl+'" target="_blank" rel="noopener">'+
              'Open the MP4</a>';
          }else{
            const t=j.result.text||'(no speech detected)';
            showData(t);
            box.innerHTML=jobLine('<span style="color:var(--teal)">Done</span> in '+secs+'s',
              j.result.characters+' characters · '+(j.result.segments||[]).length+' segments'+
              (j.result.detectedLanguage?' · '+j.result.detectedLanguage:''));
          }
        }catch(e){
          box.innerHTML=jobLine('<span style="color:var(--red)">Lost contact with the job.</span>',
            'It may still finish. Check '+window.location.origin+'/api/v1/jobs/'+jobId);
        }
      }
      let mode='video',lastResult=null,lastText='',pngPromise=null,pngBlob=null,clipboardBlocked=false;
      const $=id=>document.getElementById(id);

      document.querySelectorAll('#rateCard .row').forEach(row=>{
        row.addEventListener('click',()=>{
          document.querySelectorAll('#rateCard .row').forEach(r=>r.classList.remove('on'));
          row.classList.add('on');
          mode=row.dataset.mode;
          MODES.forEach(m=>$('f_'+m).classList.toggle('hidden',m!==mode));
          $('btnAmt').textContent='$'+PRICE[mode];
          $('out').classList.remove('show');$('fail').classList.remove('show');
          $('ladder').classList.remove('show');
        });
      });

      function copyCode(btn){
        const raw=btn.closest('.code').querySelector('pre').dataset.raw||'';
        navigator.clipboard.writeText(raw).then(()=>{
          btn.textContent='Copied';setTimeout(()=>btn.textContent='Copy',1800);
        }).catch(()=>{btn.textContent='Blocked';setTimeout(()=>btn.textContent='Copy',1800);});
      }

      /* ---------- pulse ---------- */
      function renderPulse(p){
        if(p.chain){
          $('t_gas').innerHTML=p.chain.baseFeeGwei+'<span class="u">gwei</span>';
          $('t_block').textContent=p.chain.block.toLocaleString();
          $('t_cong').textContent=p.chain.congestion;
        }
        $('t_calls').textContent=p.service.callsServed.toLocaleString();
        $('t_payers').textContent=(p.adoption?p.adoption.uniquePayers:0).toLocaleString();
        $('r_svc').textContent=p.service.endpoints;
        $('r_calls').textContent=p.service.callsServed.toLocaleString();
        const eco=p.ecosystem&&p.ecosystem.x402EndpointsIndexed;
        if(typeof eco==='number'){$('t_eco').textContent=eco.toLocaleString();
          $('t_eco_wrap').classList.remove('hidden');}
        renderCalibration(p);
        renderChart(p.adoption?p.adoption.series:[]);
      }

      function renderCalibration(p){
        const c=p.calibration,body=$('calBody');
        if(!c.forecastsResolved){
          $('calScope').textContent='';$('r_hit').textContent='—';
          body.innerHTML='<div class="empty">No forecasts have been resolved yet. Once a '+
            'journalled decision passes its target block and is audited, the result — held or '+
            'missed — is published here, misses included.</div>';
          return;
        }
        const pct=Math.round(c.hitRate*100);
        $('r_hit').innerHTML=pct+'<small>%</small>';
        $('calScope').textContent='Last '+c.recent.length+' resolved';
        const marks=c.recent.map(r=>'<span class="m '+(r.held?'h':'x')+'"></span>').join('');
        const err=c.medianAbsErrorPct===null?'—':c.medianAbsErrorPct;
        const h=Math.floor(p.service.processUptimeSeconds/3600);
        const mn=Math.floor((p.service.processUptimeSeconds%3600)/60);
        const verdict=pct>88?'running wide.':pct<72?'running narrow.':'close.';
        body.innerHTML=
          '<div class="cal"><div class="big">'+pct+'<span>%</span></div>'+
          '<p>Of <b>'+c.forecastsResolved+' resolved forecasts</b>, the 80% interval contained '+
          'the actual base fee <b>'+c.intervalContainedActual+' times</b>. A well-calibrated 80% '+
          'interval should land near 80% — this one is '+verdict+'</p></div>'+
          '<div class="strip">'+marks+'</div>'+
          '<div class="key"><span class="h"><i></i>Interval held</span>'+
          '<span class="x"><i></i>Interval missed</span>'+
          '<span style="margin-left:auto">Oldest → newest</span></div>'+
          '<div class="g4">'+
            '<div class="c4"><div class="l">Resolved</div><div class="v">'+c.forecastsResolved+'</div></div>'+
            '<div class="c4"><div class="l">Median abs error</div><div class="v">'+err+'<small>%</small></div></div>'+
            '<div class="c4"><div class="l">Calls served</div><div class="v">'+p.service.callsServed+'</div></div>'+
            '<div class="c4"><div class="l">Uptime</div><div class="v">'+h+'<small>h</small> '+mn+'<small>m</small></div></div>'+
          '</div>'+
          '<p class="vf">Every resolved forecast was checked against a specific Base block and is '+
          'verifiable on BaseScan. Read the whole record as JSON at '+
          '<a href="/api/v1/pulse">/api/v1/pulse</a> — free, no payment required.</p>';
      }

      /* ---------- adoption chart ---------- */
      function renderChart(series){
        const host=$('chartHost');
        if(!series||!series.length){
          $('adScope').textContent='';$('adRange').textContent='Awaiting first payment';
          return;
        }
        $('adScope').textContent=series.length+(series.length===1?' day':' days');
        $('adRange').textContent=series[0].date+' → '+series[series.length-1].date;

        const W=760,H=180,PAD={l:0,r:0,t:10,b:22};
        const iw=W-PAD.l-PAD.r, ih=H-PAD.t-PAD.b;
        const maxC=Math.max(1,...series.map(d=>d.calls));
        const maxP=Math.max(1,...series.map(d=>d.payers));
        const n=series.length;
        const x=i=>n===1?iw/2:PAD.l+(i/(n-1))*iw;
        const yC=v=>PAD.t+ih-(v/maxC)*ih;
        const yP=v=>PAD.t+ih-(v/maxP)*ih;

        const line=(acc,f)=>series.map((d,i)=>(i?'L':'M')+x(i).toFixed(1)+' '+f(d[acc]).toFixed(1)).join(' ');
        const area=(acc,f)=>line(acc,f)+' L'+x(n-1).toFixed(1)+' '+(PAD.t+ih)+' L'+x(0).toFixed(1)+' '+(PAD.t+ih)+' Z';

        const grid=[0,.5,1].map(t=>'<line x1="0" x2="'+W+'" y1="'+(PAD.t+ih-t*ih).toFixed(1)+
          '" y2="'+(PAD.t+ih-t*ih).toFixed(1)+'" stroke="#1C3145" stroke-width="1"/>').join('');

        const dots=n<=45?series.map((d,i)=>
          '<circle cx="'+x(i).toFixed(1)+'" cy="'+yP(d.payers).toFixed(1)+'" r="2.5" fill="#6FC3B8"/>').join(''):'';

        const labels='<text x="2" y="'+(H-6)+'" fill="#4A6076" font-family="IBM Plex Mono" font-size="10">'+
          series[0].date.slice(5)+'</text>'+
          '<text x="'+(W-2)+'" y="'+(H-6)+'" fill="#4A6076" font-family="IBM Plex Mono" '+
          'font-size="10" text-anchor="end">'+series[n-1].date.slice(5)+'</text>'+
          '<text x="2" y="'+(PAD.t+9)+'" fill="#E8A33D" font-family="IBM Plex Mono" font-size="10">'+
          maxC+' calls</text>'+
          '<text x="'+(W-2)+'" y="'+(PAD.t+9)+'" fill="#6FC3B8" font-family="IBM Plex Mono" '+
          'font-size="10" text-anchor="end">'+maxP+' wallets</text>';

        host.innerHTML='<svg class="chart" viewBox="0 0 '+W+' '+H+'" preserveAspectRatio="none" '+
          'role="img" aria-label="Cumulative calls and paying wallets since the first payment">'+
          grid+
          '<path d="'+area('calls',yC)+'" fill="rgba(232,163,61,0.10)"/>'+
          '<path d="'+line('calls',yC)+'" fill="none" stroke="#E8A33D" stroke-width="1.5" '+
            'stroke-linejoin="round" vector-effect="non-scaling-stroke"/>'+
          '<path d="'+line('payers',yP)+'" fill="none" stroke="#6FC3B8" stroke-width="1.5" '+
            'stroke-linejoin="round" vector-effect="non-scaling-stroke"/>'+
          dots+labels+'</svg>';
      }

      async function loadPulse(){
        try{
          const r=await fetch('/api/v1/pulse');
          if(!r.ok)throw new Error('HTTP '+r.status);
          renderPulse(await r.json());
        }catch(e){
          $('calBody').innerHTML='<div class="empty">The record could not be loaded.</div>';
        }
      }
      loadPulse();setInterval(loadPulse,30000);

      /* ---------- x402 handshake ---------- */
      function randomNonce(){const b=new Uint8Array(32);window.crypto.getRandomValues(b);
        return '0x'+Array.from(b,x=>x.toString(16).padStart(2,'0')).join('');}
      function b64ToJson(v){try{return JSON.parse(decodeURIComponent(escape(atob(v))));}
        catch(e){try{return JSON.parse(atob(v));}catch(e2){return null;}}}
      function jsonToB64(o){return btoa(unescape(encodeURIComponent(JSON.stringify(o))));}
      function toast(m,bad){const el=$('toast');el.className=bad?'toast bad':'toast';
        el.textContent=m;setTimeout(()=>{if(el.textContent===m)el.textContent='';},4000);}
      function slugify(t){return (t||'file').toLowerCase().replace(/[^a-z0-9]+/g,'-')
        .replace(/^-|-$/g,'').slice(0,40)||'file';}
      const IS_APPLE=/iPad|iPhone|iPod/.test(navigator.userAgent)||
        (navigator.platform==='MacIntel'&&navigator.maxTouchPoints>1);

      function resetLadder(){document.querySelectorAll('.rung').forEach(r=>r.className='rung');
        $('ladder').classList.remove('show');}
      function markStep(n){$('ladder').classList.add('show');
        document.querySelectorAll('.rung').forEach(r=>{const s=Number(r.dataset.step);
          if(s<n)r.className='rung done';else if(s===n)r.className='rung active';});}
      function failLadder(){const a=document.querySelector('.rung.active');
        if(a)a.className='rung failed';}

      async function paidCall(method,path,body,step){
        step=step||(()=>{});
        step(1);
        const init={method};
        if(body){init.headers={'Content-Type':'application/json'};init.body=JSON.stringify(body);}
        const probe=await fetch(path,init);
        if(probe.status!==402){
          const t=await probe.text();
          if(probe.ok)throw new Error('Served without payment — this route is not gated.');
          throw new Error('Expected a 402 challenge, got '+probe.status+'.');
        }
        const header=probe.headers.get('PAYMENT-REQUIRED');
        let challenge=header?b64ToJson(header):null;
        if(!challenge){try{challenge=await probe.clone().json();}catch(e){}}
        if(!challenge)throw new Error('402 received but the PAYMENT-REQUIRED header could not be read.');
        const chosen=(challenge.accepts||[]).find(o=>o.scheme==='exact'&&String(o.network||'').includes('8453'));
        if(!chosen)throw new Error('No exact/Base payment option was offered.');
        const chainId=parseInt(String(chosen.network).split(':').pop(),10);
        const amount=String(chosen.amount??chosen.maxAmountRequired);
        const asset=chosen.asset,extra=chosen.extra||{};
        const tokenName=extra.name||'USD Coin',tokenVersion=extra.version||'2';
        const timeout=chosen.maxTimeoutSeconds||600;
        if(!amount||amount==='undefined'||!asset)throw new Error('The challenge is missing an amount or asset.');

        step(2);
        const accounts=await window.ethereum.request({method:'eth_requestAccounts'});
        const userAddress=accounts[0];
        const wantHex='0x'+chainId.toString(16);
        let current=await window.ethereum.request({method:'eth_chainId'});
        if(current!==wantHex){
          try{await window.ethereum.request({method:'wallet_switchEthereumChain',
            params:[{chainId:wantHex}]});}
          catch(e){
            if(e.code===4902){await window.ethereum.request({method:'wallet_addEthereumChain',
              params:[{chainId:'0x2105',chainName:'Base',
                nativeCurrency:{name:'Ether',symbol:'ETH',decimals:18},
                rpcUrls:['https://mainnet.base.org'],
                blockExplorerUrls:['https://basescan.org']}]});}
            else throw new Error('The wallet would not switch to Base: '+(e.message||e.code));
          }
          current=await window.ethereum.request({method:'eth_chainId'});
          if(current!==wantHex)throw new Error('Wallet is on chain '+current+'; Base is '+wantHex+'.');
        }

        step(3);
        const now=Math.floor(Date.now()/1000);
        const authorization={from:userAddress,to:chosen.payTo,value:amount,
          validAfter:String(now-300),validBefore:String(now+timeout),nonce:randomNonce()};
        const typedData={
          domain:{name:tokenName,version:tokenVersion,chainId,verifyingContract:asset},
          types:{EIP712Domain:[{name:'name',type:'string'},{name:'version',type:'string'},
            {name:'chainId',type:'uint256'},{name:'verifyingContract',type:'address'}],
            TransferWithAuthorization:[{name:'from',type:'address'},{name:'to',type:'address'},
              {name:'value',type:'uint256'},{name:'validAfter',type:'uint256'},
              {name:'validBefore',type:'uint256'},{name:'nonce',type:'bytes32'}]},
          primaryType:'TransferWithAuthorization',message:authorization};
        const signature=await window.ethereum.request({method:'eth_signTypedData_v4',
          params:[userAddress,JSON.stringify(typedData)]});

        step(4);
        const paymentPayload={x402Version:challenge.x402Version??2,
          accepted:{scheme:chosen.scheme,network:chosen.network,amount,asset,payTo:chosen.payTo,
            maxTimeoutSeconds:timeout,
            extra:{assetTransferMethod:extra.assetTransferMethod||'eip3009',
              name:tokenName,version:tokenVersion}},
          payload:{signature,authorization}};
        if(challenge.extensions)paymentPayload.extensions=challenge.extensions;
        paymentPayload.resource=challenge.resource||{
          url:window.location.origin+path.split('?')[0],description:'',mimeType:'application/json'};

        const headers={'PAYMENT-SIGNATURE':jsonToB64(paymentPayload)};
        if(body)headers['Content-Type']='application/json';
        const paid=await fetch(path,{method,headers,body:body?JSON.stringify(body):undefined});
        const rawBody=await paid.text();
        const sh=paid.headers.get('PAYMENT-RESPONSE');
        const settlement=sh?b64ToJson(sh):null;
        if(!paid.ok){
          let detail=rawBody;
          try{const p=JSON.parse(rawBody);detail=p.error||p.errorReason||p.message||rawBody;}catch(e){}
          throw new Error(detail);
        }
        step(5);
        return {data:JSON.parse(rawBody),settlement};
      }

      function drawBand(low,center,high,actual,held){
        const lo=Math.min(low,actual===null?low:actual);
        const hi=Math.max(high,actual===null?high:actual);
        const pad=(hi-lo)*0.25||Math.max(hi*0.1,0.0001);
        const min=lo-pad,max=hi+pad,span=max-min||1;
        const pct=v=>((v-min)/span)*100;
        let h='<div class="ax"></div>';
        h+='<div class="rg" style="left:'+pct(low)+'%;width:'+(pct(high)-pct(low))+'%"></div>';
        h+='<div class="tg up a" style="left:'+pct(low)+'%">'+low+'</div>';
        h+='<div class="tg up a" style="left:'+pct(high)+'%">'+high+'</div>';
        h+='<div class="nd" style="left:'+pct(center)+'%"></div>';
        h+='<div class="tg dn a" style="left:'+pct(center)+'%">forecast '+center+'</div>';
        if(actual!==null){
          h+='<div class="ac'+(held?'':' missed')+'" style="left:'+pct(actual)+'%"></div>';
          h+='<div class="tg dn '+(held?'t':'r')+'" style="left:'+pct(actual)+'%">actual '+actual+'</div>';
        }
        $('band').innerHTML=h;$('meter').classList.remove('hidden');
      }

      function showImage(d){
        const img=$('image');
        img.src='data:'+(d.mimeType||'image/webp')+';base64,'+d.image;
        img.classList.remove('hidden');$('data').classList.add('hidden');
        $('meter').classList.add('hidden');$('imageActs').classList.remove('hidden');
        $('textActs').classList.add('hidden');preparePng();
      }
      function showData(o){
        lastText=typeof o==='string'?o:JSON.stringify(o,null,2);
        $('data').textContent=lastText;$('data').classList.remove('hidden');
        $('image').classList.add('hidden');$('imageActs').classList.add('hidden');
        $('textActs').classList.remove('hidden');
      }
      function preparePng(){
        const img=$('image');
        pngPromise=img.decode().then(()=>{
          const c=document.createElement('canvas');
          c.width=img.naturalWidth;c.height=img.naturalHeight;
          c.getContext('2d').drawImage(img,0,0);
          return new Promise((res,rej)=>c.toBlob(b=>b?res(b):rej(new Error('encode failed')),'image/png'));
        }).then(b=>{pngBlob=b;return b;});
      }
      function openInTab(){if(!lastResult||!lastResult.imageUrl)return;
        window.open(lastResult.imageUrl,'_blank');
        toast('Opened full size — long-press to add to Photos');}
      function saveImage(){
        if(!lastResult)return;
        const name=slugify(lastResult.prompt)+'.png';
        if(pngBlob){
          const file=new File([pngBlob],name,{type:'image/png'});
          if(IS_APPLE&&navigator.canShare&&navigator.canShare({files:[file]})){
            navigator.share({files:[file]}).catch(e=>{if(e&&e.name!=='AbortError')openInTab();});return;}
          try{const url=URL.createObjectURL(pngBlob);const a=document.createElement('a');
            a.href=url;a.download=name;document.body.appendChild(a);a.click();a.remove();
            setTimeout(()=>URL.revokeObjectURL(url),10000);toast('Saved to downloads');return;}catch(e){}
        }
        openInTab();
      }
      function copyImage(){
        if(!pngPromise)return;
        if(clipboardBlocked||!navigator.clipboard||!window.ClipboardItem)return shareImage();
        navigator.clipboard.write([new ClipboardItem({'image/png':pngPromise})])
          .then(()=>toast('Image copied'))
          .catch(()=>{clipboardBlocked=true;$('copyImgBtn').textContent='Share image';
            toast('Clipboard is blocked here — tap again to share',true);});
      }
      async function shareImage(){
        try{
          const blob=pngBlob||await pngPromise;
          const file=new File([blob],slugify(lastResult&&lastResult.prompt)+'.png',{type:'image/png'});
          if(navigator.canShare&&navigator.canShare({files:[file]}))return await navigator.share({files:[file]});
          throw new Error('unsupported');
        }catch(e){if(e&&e.name==='AbortError')return;openInTab();}
      }
      async function copyLink(){
        if(!lastResult)return;
        const link=lastResult.absoluteUrl||(lastResult.imageUrl?window.location.origin+lastResult.imageUrl:null);
        if(!link)return toast('This result has no stored URL',true);
        try{await navigator.clipboard.writeText(link);toast('Link copied');}catch(e){toast(link,true);}
      }
      async function copyText(){
        if(!lastText)return;
        try{await navigator.clipboard.writeText(lastText);toast('Copied');}
        catch(e){toast('Clipboard is blocked here — select the text instead',true);}
      }
      function fileToBase64(file){
        return new Promise((res,rej)=>{const r=new FileReader();
          r.onload=()=>res(String(r.result).split(',')[1]);
          r.onerror=()=>rej(new Error('Could not read that file'));r.readAsDataURL(file);});
      }

      async function run(){
        const btn=$('btn'),failBox=$('fail');
        const fail=m=>{failLadder();failBox.textContent=m;failBox.classList.add('show');};
        if(!window.ethereum){resetLadder();
          return fail('No wallet found in this browser. Open this page inside MetaMask, Coinbase Wallet, or Phantom.');}

        stopPolling();
        lastResult=null;lastText='';pngPromise=null;pngBlob=null;clipboardBlocked=false;
        $('copyImgBtn').textContent='Copy image';
        $('out').classList.remove('show');$('meter').classList.add('hidden');
        $('video').classList.add('hidden');$('video').removeAttribute('src');
        $('jobBox').classList.add('hidden');$('jobBox').innerHTML='';
        $('meterVerdict').className='vd';$('meterVerdict').textContent='';
        failBox.classList.remove('show');resetLadder();btn.disabled=true;
        const step=n=>markStep(n);

        try{
          let settlement=null,metaHtml='';
          if(mode==='image'){
            const prompt=$('prompt').value.trim();
            if(!prompt)throw new Error('Enter a prompt first.');
            const r=await paidCall('GET','/api/v1/generate-image?prompt='+encodeURIComponent(prompt),null,step);
            settlement=r.settlement;
            if(!r.data.image)throw new Error('Payment settled but no image came back.');
            lastResult=r.data;showImage(r.data);
            metaHtml='Model '+(r.data.model||'')+' · '+(r.data.mimeType||'');
          }else if(mode==='pdf'){
            const url=$('pdfUrl').value.trim(),file=$('pdfFile').files[0];
            if(!url&&!file)throw new Error('Give a PDF address or choose a file.');
            const body={};
            if(file){if(file.size>20*1024*1024)throw new Error('That file is over the 20 MB ceiling.');
              body.pdf=await fileToBase64(file);}else body.url=url;
            const r=await paidCall('POST','/api/v1/pdf-to-markdown',body,step);
            settlement=r.settlement;lastResult=r.data;
            showData(r.data.markdown||'(no text layer found — this is probably a scan)');
            metaHtml=r.data.pages+' pages · '+r.data.characters+' characters'+
              (r.data.title?' · '+r.data.title:'');
          }else if(mode==='video'){
            const p=$('vPrompt').value.trim();
            if(!p)throw new Error('Enter a prompt first.');
            const body={prompt:p,durationSeconds:Math.max(3,Math.min(5,Number($('vDur').value)||5))};
            const img=$('vImage').value.trim();
            if(img)body.imageUrl=img;
            const r=await paidCall('POST','/api/v1/video',body,step);
            settlement=r.settlement;
            $('out').classList.add('show');
            pollJob(r.data.jobId,'video',Date.now());
            metaHtml='Job '+r.data.jobId;
          }else if(mode==='transcribe'){
            const u=$('aUrl').value.trim();
            if(!u)throw new Error('Give a public audio or video URL.');
            const body={audioUrl:u};
            const lang=$('aLang').value.trim();
            if(lang)body.language=lang;
            const r=await paidCall('POST','/api/v1/transcribe',body,step);
            settlement=r.settlement;
            $('out').classList.add('show');
            pollJob(r.data.jobId,'transcribe',Date.now());
            metaHtml='Job '+r.data.jobId;
          }else if(mode==='preflight'){
            const h=Math.max(1,Math.min(60,Number($('horizon1').value)||5));
            const r=await paidCall('GET','/api/v1/gas/preflight?horizonMinutes='+h,null,step);
            settlement=r.settlement;lastResult=r.data;
            const f=r.data.forecast;
            $('meterTitle').textContent='Fee band · gwei · '+h+' min';
            drawBand(f.lowGwei,f.centerGwei,f.highGwei,r.data.current.baseFeeGwei,true);
            $('meterVerdict').textContent=r.data.current.congestion;
            showData(r.data);
            metaHtml='Block '+r.data.block+' · base fee '+r.data.current.baseFeeGwei+
              ' gwei · '+r.data.recent.blocks+' blocks observed';
          }else if(mode==='decision'){
            const body={stance:$('stance').value,
              horizonMinutes:Math.max(1,Math.min(60,Number($('horizon2').value)||15))};
            const r=await paidCall('POST','/api/v1/gas/decision',body,step);
            settlement=r.settlement;lastResult=r.data;
            const s=r.data.snapshot;
            $('meterTitle').textContent='Fee band at journal time · gwei';
            drawBand(s.lowGwei,s.centerGwei,s.highGwei,s.baseFeeGwei,true);
            $('meterVerdict').textContent='recorded';
            showData(r.data);
            metaHtml='Auditable from '+new Date(r.data.auditableAt).toLocaleTimeString()+
              ' · target block '+r.data.targetBlock+'<br>ID '+r.data.decisionId;
          }else if(mode==='audit'){
            const id=$('decisionId').value.trim();
            if(!/^[a-f0-9]{32}$/.test(id))throw new Error('A decision ID is 32 hexadecimal characters.');
            const r=await paidCall('GET','/api/v1/gas/audit/'+id,null,step);
            settlement=r.settlement;lastResult=r.data;
            const f=r.data.forecast;
            if(r.data.status==='pending'){
              $('meterTitle').textContent='Fee band · awaiting block '+r.data.targetBlock;
              drawBand(f.lowGwei,f.centerGwei,f.highGwei,null,true);
              $('meterVerdict').textContent='pending';
              metaHtml=r.data.blocksRemaining+' blocks to go · about '+
                Math.ceil(r.data.secondsRemaining/60)+' min';
            }else{
              const held=r.data.rangeContainedActual;
              $('meterTitle').textContent='Fee band · resolved at block '+r.data.actual.block;
              drawBand(f.lowGwei,f.centerGwei,f.highGwei,r.data.actual.baseFeeGwei,held);
              $('meterVerdict').className='vd '+(held?'held':'missed');
              $('meterVerdict').textContent=held?'range held':'range missed';
              metaHtml=r.data.explanation+'<br><a href="'+r.data.verify+
                '" target="_blank" rel="noopener">Verify on BaseScan</a>';
            }
            showData(r.data);
          }
          const tx=settlement&&settlement.transaction;
          if(tx)metaHtml+=(metaHtml?'<br>':'')+'Receipt <a href="https://basescan.org/tx/'+tx+
            '" target="_blank" rel="noopener">'+tx.slice(0,18)+'…</a>';
          $('meta').innerHTML=metaHtml;$('out').classList.add('show');markStep(6);
          setTimeout(loadPulse,2500);
        }catch(err){
          fail(err.message||String(err));console.error(err);
        }finally{btn.disabled=false;}
      }
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
// 4b. Public pulse — free, unauthenticated, cached.
//
//     Registered before the payment middleware so it stays free. Cached hard,
//     because a free endpoint that hits Base RPC on every request is a cost
//     and rate-limit vector. Agents can read this to decide whether to trust
//     the paid forecasts before spending anything.
// ---------------------------------------------------------------------------
const PULSE_TTL_MS = 20000;
const BAZAAR_TTL_MS = 10 * 60 * 1000;
let pulseCache = { at: 0, data: null };
let bazaarCache = { at: 0, count: null };

async function bazaarEndpointCount() {
  if (Date.now() - bazaarCache.at < BAZAAR_TTL_MS) return bazaarCache.count;
  bazaarCache.at = Date.now();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    const res = await fetch(
      'https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources?limit=1',
      { signal: controller.signal }
    );
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    // Shape varies; take whichever total the response actually carries.
    const total = json.pagination?.total ?? json.total ?? json.count ?? null;
    bazaarCache.count = typeof total === 'number' ? total : null;
  } catch (err) {
    // Not fatal — the UI simply omits the tile when this is null.
    bazaarCache.count = null;
  }
  return bazaarCache.count;
}

app.get('/api/v1/pulse', async (req, res) => {
  if (pulseCache.data && Date.now() - pulseCache.at < PULSE_TTL_MS) {
    res.set('Cache-Control', 'public, max-age=20');
    return res.json(pulseCache.data);
  }

  const cal = stats.calibration;
  const hitRate = cal.resolved ? cal.contained / cal.resolved : null;
  const medianErr = medianOf(cal.absErrors);

  const payload = {
    service: {
      name: 'Lotus Network API',
      url: BASE_URL,
      endpoints: ENDPOINTS.length,
      callsServed: stats.callsServed,
      byEndpoint: stats.byEndpoint,
      since: stats.since,
      processUptimeSeconds: Math.round(process.uptime())
    },
    adoption: {
      uniquePayers: stats.payers.length,
      series: buildSeries(),
      note:
        'uniquePayers counts distinct wallet addresses that have settled a payment to this ' +
        'API, read from the EIP-3009 authorization. It is not a count of agents: nothing ' +
        'on-chain distinguishes an autonomous agent from a person with a wallet. The series ' +
        'begins on the first day of recorded activity and extends as data accumulates.'
    },
    calibration: {
      targetInterval: 0.8,
      forecastsResolved: cal.resolved,
      intervalContainedActual: cal.contained,
      hitRate: hitRate === null ? null : Number(hitRate.toFixed(4)),
      medianAbsErrorPct: medianErr === null ? null : Number(medianErr.toFixed(2)),
      recent: cal.recent,
      note:
        'Each entry is a gas forecast that was journalled, then checked against the base fee ' +
        'at its target block. A well-calibrated 80% interval should contain the actual value ' +
        'about 80% of the time. Every figure is reproducible from public Base RPC data.'
    },
    generatedAt: new Date().toISOString()
  };

  // Chain and ecosystem reads can fail without invalidating the rest.
  try {
    const s = await gasSnapshot(5);
    payload.chain = {
      network: 'base-mainnet',
      block: s.currentBlock,
      baseFeeGwei: round(weiToGwei(s.current)),
      congestion: s.congestion
    };
  } catch (err) {
    payload.chain = null;
  }

  payload.ecosystem = { x402EndpointsIndexed: await bazaarEndpointCount() };

  pulseCache = { at: Date.now(), data: payload };
  res.set('Cache-Control', 'public, max-age=20');
  res.json(payload);
});

// ---------------------------------------------------------------------------
// 4c. Job status and asset retrieval — free, before the payment middleware.
//
//     The work was already paid for when the job was created. Charging again
//     to collect the result would be indefensible, and would also mean an
//     agent pays every time it polls.
// ---------------------------------------------------------------------------
app.get('/api/v1/jobs/:id', async (req, res) => {
  if (!/^[a-f0-9]{32}$/.test(req.params.id)) {
    return res.status(400).json({ error: 'Malformed job id' });
  }

  const job = await loadJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found. Jobs are kept for seven days.' });

  // Lazy progress check: only talk to Replicate when someone is actually asking.
  if (job.status === 'processing' && job.predictionId) {
    try {
      const p = await replicateGet(job.predictionId);

      if (p.status === 'succeeded') {
        if (job.kind === 'video') {
          const url = firstUrl(p.output);
          if (!url) throw new Error('Model returned no video URL');
          const file = await fetch(url);
          if (!file.ok) throw new Error(`Could not download the video: ${file.status}`);
          const buffer = Buffer.from(await file.arrayBuffer());
          const assetId = await storeAsset(buffer, file.headers.get('content-type') || 'video/mp4');
          job.status = 'completed';
          job.result = {
            videoUrl: `${BASE_URL}/api/v1/asset/${assetId}`,
            sizeBytes: buffer.length,
            mimeType: file.headers.get('content-type') || 'video/mp4',
            model: job.model
          };
          console.log(`[video] job ${job.id} done, ${Math.round(buffer.length / 1024)} KB`);
        } else {
          const out = p.output || {};
          const text = typeof out === 'string' ? out : (out.transcription || out.text || '');
          const segments = Array.isArray(out.segments)
            ? out.segments.map(s => ({
                start: s.start, end: s.end, text: (s.text || '').trim()
              }))
            : [];
          job.status = 'completed';
          job.result = {
            text,
            characters: text.length,
            segments,
            detectedLanguage: out.detected_language || out.language || null,
            model: job.model
          };
          console.log(`[transcribe] job ${job.id} done, ${text.length} chars`);
        }
        await storeJob(job);

      } else if (p.status === 'failed' || p.status === 'canceled') {
        job.status = 'failed';
        job.error = p.error || `Model run ${p.status}`;
        await storeJob(job);
        console.error(`[jobs] ${job.id} failed:`, job.error);
      }
    } catch (err) {
      console.error('[jobs] progress check failed:', err.message);
      // Leave the job processing — a transient Replicate error shouldn't kill it.
    }
  }

  const age = Date.now() - new Date(job.createdAt).getTime();
  const payload = {
    success: job.status !== 'failed',
    jobId: job.id,
    kind: job.kind,
    status: job.status,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    ageSeconds: Math.round(age / 1000)
  };
  if (job.status === 'processing') payload.pollAfterSeconds = job.kind === 'video' ? 20 : 15;
  if (job.status === 'completed') payload.result = job.result;
  if (job.status === 'failed') {
    payload.error = job.error;
    payload.note = 'This job was paid for and did not deliver. Quote the job id for a credit.';
  }
  res.json(payload);
});

app.get('/api/v1/asset/:id', async (req, res) => {
  if (!/^[a-f0-9]{32}$/.test(req.params.id)) {
    return res.status(400).json({ error: 'Malformed asset id' });
  }
  const asset = await loadAsset(req.params.id);
  if (!asset) return res.status(404).json({ error: 'Asset not found' });

  res.set('Content-Type', asset.mimeType);
  res.set('Cache-Control', 'public, max-age=31536000, immutable');
  res.set('Accept-Ranges', 'bytes');
  if (req.query.download !== undefined) {
    res.set('Content-Disposition', 'attachment');
  }
  res.send(asset.buffer);
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

    // The payer address is inside the EIP-3009 authorization the client signed.
    let payer = null;
    try {
      const decoded = JSON.parse(Buffer.from(sig, 'base64').toString('utf8'));
      payer = decoded?.payload?.authorization?.from || null;
    } catch (e) {
      // A malformed header is the middleware's problem, not ours.
    }
    recordCall(`${req.method} ${req.path}`, payer);
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

app.post('/api/v1/video', async (req, res) => {
  const { prompt, imageUrl, durationSeconds } = req.body || {};
  const text = (prompt || '').toString().trim();
  if (!text) return res.status(400).json({ error: 'Missing prompt' });

  try {
    if (imageUrl) await assertPublicUrl(imageUrl);

    const input = {
      prompt: text,
      duration: Math.max(3, Math.min(5, Number(durationSeconds) || 5)),
      resolution: VIDEO_RESOLUTION,
      // The model ships with disable_safety_filter defaulting to true. This is
      // a public endpoint any agent can call with any prompt, so turn the
      // filter back on rather than run an unfiltered generator on our account.
      disable_safety_filter: false
    };
    if (imageUrl) input.image = imageUrl;

    const prediction = await replicateStart(REPLICATE_VIDEO_MODEL, input);

    const job = {
      id: crypto.randomBytes(16).toString('hex'),
      kind: 'video',
      status: 'processing',
      createdAt: new Date().toISOString(),
      predictionId: prediction.id,
      model: REPLICATE_VIDEO_MODEL,
      params: { prompt: text, imageUrl: imageUrl || null, durationSeconds: input.duration }
    };
    await storeJob(job);
    console.log(`[video] job ${job.id} started (${prediction.id})`);

    res.json({
      success: true,
      status: 'processing',
      jobId: job.id,
      statusUrl: `${BASE_URL}/api/v1/jobs/${job.id}`,
      pollAfterSeconds: 20,
      note: 'Polling the status URL is free. Video generation usually takes one to three minutes.'
    });
  } catch (err) {
    console.error('[video] FAILED AFTER PAYMENT:', err.message);
    res.status(502).json({ error: 'Payment settled but the job could not be started: ' + err.message });
  }
});

app.post('/api/v1/transcribe', async (req, res) => {
  const { audioUrl, language, translate } = req.body || {};
  if (!audioUrl) return res.status(400).json({ error: 'Missing audioUrl' });

  try {
    await assertPublicUrl(audioUrl);

    // A cheap HEAD first, so an obviously oversized file fails before we spend
    // GPU time on it.
    try {
      const head = await fetch(audioUrl, { method: 'HEAD' });
      const len = Number(head.headers.get('content-length') || 0);
      if (len && len > AUDIO_MAX_BYTES) {
        throw new Error(`That file is ${Math.round(len / 1048576)} MB; the limit is 200 MB`);
      }
    } catch (e) {
      if (/limit is 200 MB/.test(e.message)) throw e;
      // Some hosts refuse HEAD. Carry on and let the model decide.
    }

    const input = { audio: audioUrl };
    if (language) input.language = language;
    if (translate) input.translate = true;

    const prediction = await replicateStart(REPLICATE_AUDIO_MODEL, input);

    const job = {
      id: crypto.randomBytes(16).toString('hex'),
      kind: 'transcribe',
      status: 'processing',
      createdAt: new Date().toISOString(),
      predictionId: prediction.id,
      model: REPLICATE_AUDIO_MODEL,
      params: { audioUrl, language: language || null, translate: Boolean(translate) }
    };
    await storeJob(job);
    console.log(`[transcribe] job ${job.id} started (${prediction.id})`);

    res.json({
      success: true,
      status: 'processing',
      jobId: job.id,
      statusUrl: `${BASE_URL}/api/v1/jobs/${job.id}`,
      pollAfterSeconds: 15,
      note: 'Polling the status URL is free. Expect roughly one minute per hour of audio.'
    });
  } catch (err) {
    console.error('[transcribe] FAILED AFTER PAYMENT:', err.message);
    res.status(502).json({ error: 'Payment settled but the job could not be started: ' + err.message });
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

    // Count each decision once, however many times it is audited afterwards.
    if (!record.auditRecorded) {
      recordAudit({ held: contained, changePct });
      record.auditRecorded = true;
      storeDecision(id, record).catch(e => console.error('[gas] could not mark audited:', e.message));
    }

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