#!/usr/bin/env node
/**
 * Lotus Network MCP server
 *
 * Exposes five x402-gated endpoints as MCP tools so a model in Claude Desktop,
 * Cursor, or any other MCP host can call them. The server holds a wallet and
 * performs the x402 V2 handshake on the model's behalf:
 *
 *   1. call the endpoint with no PAYMENT-SIGNATURE  -> 402 + PAYMENT-REQUIRED
 *   2. sign an EIP-3009 TransferWithAuthorization for exactly what it asks
 *   3. retry with PAYMENT-SIGNATURE                 -> 200 + PAYMENT-RESPONSE
 *
 * SPENDING: this process can move real USDC. Caps are enforced below and are
 * deliberately conservative. Nothing is spent without a tool call from the
 * host, but a model decides when to make those calls — so treat the configured
 * wallet as a small float, not a treasury.
 *
 * Never write to stdout: it carries the JSON-RPC stream. Log to stderr.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { privateKeyToAccount } from 'viem/accounts';
import { randomBytes } from 'node:crypto';

const BASE_URL = (process.env.LOTUS_API_URL || 'https://lotusnetworkapi.com').replace(/\/$/, '');
const PRIVATE_KEY = process.env.WALLET_PRIVATE_KEY;

// Spend guards. MAX_CALL is a hard ceiling on any single payment; MAX_SESSION
// bounds everything this process will spend before it must be restarted.
const MAX_CALL_USD = Number(process.env.MAX_CALL_USD || 0.10);
const MAX_SESSION_USD = Number(process.env.MAX_SESSION_USD || 1.00);

let spentUsd = 0;
let callCount = 0;

const log = (...args) => console.error('[lotus-mcp]', ...args);

if (!PRIVATE_KEY) {
  log('FATAL: WALLET_PRIVATE_KEY is not set. Add it to your MCP client config.');
  process.exit(1);
}

const account = privateKeyToAccount(
  PRIVATE_KEY.startsWith('0x') ? PRIVATE_KEY : `0x${PRIVATE_KEY}`
);

log(`wallet ${account.address}`);
log(`target ${BASE_URL}`);
log(`caps: $${MAX_CALL_USD.toFixed(3)}/call, $${MAX_SESSION_USD.toFixed(2)}/session`);

// ---------------------------------------------------------------------------
// x402 V2 handshake
// ---------------------------------------------------------------------------
function b64ToJson(value) {
  return JSON.parse(Buffer.from(value, 'base64').toString('utf8'));
}
function jsonToB64(obj) {
  return Buffer.from(JSON.stringify(obj), 'utf8').toString('base64');
}

async function paidCall(method, path, body) {
  const url = BASE_URL + path;
  const init = { method };
  if (body) {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = JSON.stringify(body);
  }

  // --- 1. unpaid probe -----------------------------------------------------
  const probe = await fetch(url, init);

  if (probe.status !== 402) {
    const text = await probe.text();
    if (probe.ok) return { data: JSON.parse(text), settlement: null, paidUsd: 0 };
    throw new Error(`Expected a 402 challenge, got ${probe.status}: ${text.slice(0, 400)}`);
  }

  const header = probe.headers.get('PAYMENT-REQUIRED');
  let challenge = null;
  if (header) {
    try { challenge = b64ToJson(header); } catch (e) { /* fall through */ }
  }
  if (!challenge) {
    try { challenge = await probe.clone().json(); } catch (e) { /* fall through */ }
  }
  if (!challenge) throw new Error('402 received but the PAYMENT-REQUIRED header could not be read.');

  const chosen = (challenge.accepts || []).find(
    o => o.scheme === 'exact' && String(o.network || '').includes('8453')
  );
  if (!chosen) throw new Error('No exact/Base payment option was offered.');

  const amountAtomic = String(chosen.amount ?? chosen.maxAmountRequired);
  const asset = chosen.asset;
  if (!amountAtomic || amountAtomic === 'undefined' || !asset) {
    throw new Error('The challenge is missing an amount or asset.');
  }

  // --- 2. spend guards -----------------------------------------------------
  const usd = Number(amountAtomic) / 1e6;          // USDC has 6 decimals
  if (usd > MAX_CALL_USD) {
    throw new Error(
      `This call costs $${usd.toFixed(4)}, above the per-call cap of $${MAX_CALL_USD.toFixed(3)}. ` +
      `Raise MAX_CALL_USD if that is intended.`
    );
  }
  if (spentUsd + usd > MAX_SESSION_USD) {
    throw new Error(
      `This call would take the session total to $${(spentUsd + usd).toFixed(4)}, ` +
      `over the session cap of $${MAX_SESSION_USD.toFixed(2)}. Restart the server or raise MAX_SESSION_USD.`
    );
  }

  // --- 3. sign the EIP-3009 authorization ----------------------------------
  const extra = chosen.extra || {};
  const chainId = parseInt(String(chosen.network).split(':').pop(), 10);
  const timeout = chosen.maxTimeoutSeconds || 600;
  const now = Math.floor(Date.now() / 1000);

  const authorization = {
    from: account.address,
    to: chosen.payTo,
    value: amountAtomic,
    validAfter: String(now - 300),                 // backdated for clock skew
    validBefore: String(now + timeout),
    nonce: '0x' + randomBytes(32).toString('hex')
  };

  const signature = await account.signTypedData({
    domain: {
      name: extra.name || 'USD Coin',
      version: extra.version || '2',
      chainId,
      verifyingContract: asset
    },
    types: {
      TransferWithAuthorization: [
        { name: 'from', type: 'address' },
        { name: 'to', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'validAfter', type: 'uint256' },
        { name: 'validBefore', type: 'uint256' },
        { name: 'nonce', type: 'bytes32' }
      ]
    },
    primaryType: 'TransferWithAuthorization',
    message: {
      from: authorization.from,
      to: authorization.to,
      value: BigInt(authorization.value),
      validAfter: BigInt(authorization.validAfter),
      validBefore: BigInt(authorization.validBefore),
      nonce: authorization.nonce
    }
  });

  // --- 4. retry with payment ----------------------------------------------
  const paymentPayload = {
    x402Version: challenge.x402Version ?? 2,
    accepted: {
      scheme: chosen.scheme,
      network: chosen.network,
      amount: amountAtomic,
      asset,
      payTo: chosen.payTo,
      maxTimeoutSeconds: timeout,
      extra: {
        assetTransferMethod: extra.assetTransferMethod || 'eip3009',
        name: extra.name || 'USD Coin',
        version: extra.version || '2'
      }
    },
    payload: { signature, authorization }
  };

  // The Bazaar reads discovery metadata out of the client's payload, and the
  // resource object lives at the top level of the challenge — not inside an
  // accepts entry. Omitting either breaks indexing for the seller.
  if (challenge.extensions) paymentPayload.extensions = challenge.extensions;
  paymentPayload.resource = challenge.resource || {
    url: BASE_URL + path.split('?')[0],
    description: '',
    mimeType: 'application/json'
  };

  const headers = { 'PAYMENT-SIGNATURE': jsonToB64(paymentPayload) };
  if (body) headers['Content-Type'] = 'application/json';

  const paid = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const rawBody = await paid.text();
  const settleHeader = paid.headers.get('PAYMENT-RESPONSE');
  let settlement = null;
  if (settleHeader) {
    try { settlement = b64ToJson(settleHeader); } catch (e) { /* non-fatal */ }
  }

  if (!paid.ok) {
    let detail = rawBody;
    try {
      const parsed = JSON.parse(rawBody);
      detail = parsed.error || parsed.message || rawBody;
    } catch (e) { /* keep raw */ }
    throw new Error(`HTTP ${paid.status}: ${detail}`);
  }

  spentUsd += usd;
  callCount += 1;
  log(`paid $${usd.toFixed(4)} for ${method} ${path} (session $${spentUsd.toFixed(4)}, ${callCount} calls)`);

  return { data: JSON.parse(rawBody), settlement, paidUsd: usd };
}

// Shared footer so the model can see cost and receipt on every result.
function receipt(paidUsd, settlement) {
  const tx = settlement && settlement.transaction;
  const parts = [`Paid $${paidUsd.toFixed(4)} USDC on Base.`];
  if (tx) parts.push(`Receipt: https://basescan.org/tx/${tx}`);
  parts.push(`Session spend: $${spentUsd.toFixed(4)} of $${MAX_SESSION_USD.toFixed(2)}.`);
  return parts.join(' ');
}

function errorResult(err) {
  return {
    isError: true,
    content: [{ type: 'text', text: `Lotus Network call failed: ${err.message}` }]
  };
}

// ---------------------------------------------------------------------------
// MCP server
// ---------------------------------------------------------------------------
const server = new McpServer({ name: 'lotus-network', version: '1.0.0' });

server.registerTool(
  'generate_image',
  {
    title: 'Generate an image',
    description:
      'Generate a 1024x1024 image from a text prompt using FLUX. Costs $0.05 in USDC per call. ' +
      'Returns the image itself plus a permanent URL. Use when the user asks for an original ' +
      'picture, illustration, or visual concept.',
    inputSchema: {
      prompt: z.string().min(1).describe('What the image should show')
    }
  },
  async ({ prompt }) => {
    try {
      const { data, settlement, paidUsd } = await paidCall(
        'GET', '/api/v1/generate-image?prompt=' + encodeURIComponent(prompt)
      );
      const content = [];
      if (data.image) {
        content.push({ type: 'image', data: data.image, mimeType: data.mimeType || 'image/webp' });
      }
      content.push({
        type: 'text',
        text: [
          `Prompt: ${data.prompt}`,
          `Model: ${data.model}`,
          data.absoluteUrl ? `URL: ${data.absoluteUrl}` : null,
          receipt(paidUsd, settlement)
        ].filter(Boolean).join('\n')
      });
      return { content };
    } catch (err) {
      return errorResult(err);
    }
  }
);

server.registerTool(
  'pdf_to_markdown',
  {
    title: 'Convert a PDF to Markdown',
    description:
      'Extract the text layer of a PDF and return clean Markdown with headings, lists, and ' +
      'unwrapped paragraphs. Costs $0.005 in USDC per call. Accepts a public URL or base64 bytes. ' +
      'Use when you need to read a PDF you cannot open directly. Scanned PDFs have no text layer ' +
      'and will come back empty.',
    inputSchema: {
      url: z.string().url().optional().describe('Public URL of the PDF'),
      pdfBase64: z.string().optional().describe('Base64-encoded PDF bytes, if there is no URL'),
      pageMarkers: z.boolean().optional().describe('Insert page separators in the output')
    }
  },
  async ({ url, pdfBase64, pageMarkers }) => {
    try {
      if (!url && !pdfBase64) throw new Error('Provide either url or pdfBase64.');
      const body = {};
      if (url) body.url = url;
      if (pdfBase64) body.pdf = pdfBase64;
      if (pageMarkers) body.pageMarkers = true;

      const { data, settlement, paidUsd } = await paidCall('POST', '/api/v1/pdf-to-markdown', body);
      return {
        content: [{
          type: 'text',
          text: [
            data.title ? `# ${data.title}` : null,
            `(${data.pages} pages, ${data.characters} characters)`,
            '',
            data.markdown || '(no text layer found — this is probably a scanned PDF)',
            '',
            receipt(paidUsd, settlement)
          ].filter(v => v !== null).join('\n')
        }]
      };
    } catch (err) {
      return errorResult(err);
    }
  }
);

server.registerTool(
  'gas_preflight',
  {
    title: 'Check Base gas conditions',
    description:
      'Read current Base L2 gas conditions and get an 80% forecast range for a chosen horizon. ' +
      'Costs $0.002 in USDC per call. Returns the current base fee, recent percentiles, realised ' +
      'volatility, congestion state, and a projected range. Supporting context for deciding when ' +
      'to submit a transaction — not a trade instruction. Computed from public Base RPC data.',
    inputSchema: {
      horizonMinutes: z.number().int().min(1).max(60).optional()
        .describe('How far ahead to forecast, 1-60 minutes (default 5)')
    }
  },
  async ({ horizonMinutes }) => {
    try {
      const h = horizonMinutes || 5;
      const { data, settlement, paidUsd } = await paidCall(
        'GET', '/api/v1/gas/preflight?horizonMinutes=' + h
      );
      return {
        content: [{
          type: 'text',
          text: [
            `Base block ${data.block} — ${data.current.congestion}`,
            `Base fee now: ${data.current.baseFeeGwei} gwei`,
            `Recent ${data.recent.blocks} blocks: median ${data.recent.medianGwei}, ` +
              `p10 ${data.recent.p10Gwei}, p90 ${data.recent.p90Gwei} gwei`,
            `Forecast for +${h} min (80% interval): ${data.forecast.lowGwei} to ` +
              `${data.forecast.highGwei} gwei, centre ${data.forecast.centerGwei}`,
            `Target block: ${data.forecast.targetBlock}`,
            '',
            receipt(paidUsd, settlement)
          ].join('\n')
        }],
        structuredContent: data
      };
    } catch (err) {
      return errorResult(err);
    }
  }
);

server.registerTool(
  'gas_decision',
  {
    title: 'Journal a gas timing decision',
    description:
      'Record a decision to execute now or wait, against a fresh gas forecast snapshot. ' +
      'Costs $0.003 in USDC per call. Returns a decision_id and the block at which the outcome ' +
      'becomes checkable. Nothing is predicted beyond the snapshot — this is a tamper-evident ' +
      'journal entry so the decision can be verified later with gas_audit. Keep the decision_id.',
    inputSchema: {
      stance: z.enum(['execute', 'wait']).describe('The decision being recorded'),
      horizonMinutes: z.number().int().min(1).max(60).optional()
        .describe('How long until the decision can be audited (default 5)'),
      maxFeeGwei: z.number().optional().describe('Optional ceiling you were willing to pay'),
      note: z.string().max(500).optional().describe('Optional rationale, kept with the record')
    }
  },
  async ({ stance, horizonMinutes, maxFeeGwei, note }) => {
    try {
      const body = { stance };
      if (horizonMinutes) body.horizonMinutes = horizonMinutes;
      if (typeof maxFeeGwei === 'number') body.maxFeeGwei = maxFeeGwei;
      if (note) body.note = note;

      const { data, settlement, paidUsd } = await paidCall('POST', '/api/v1/gas/decision', body);
      return {
        content: [{
          type: 'text',
          text: [
            `Recorded "${data.stance}" as decision ${data.decisionId}`,
            `Snapshot: base fee ${data.snapshot.baseFeeGwei} gwei, ` +
              `80% range ${data.snapshot.lowGwei}–${data.snapshot.highGwei}`,
            `Auditable from ${data.auditableAt} (block ${data.targetBlock})`,
            `Audit with: gas_audit decisionId="${data.decisionId}"`,
            '',
            receipt(paidUsd, settlement)
          ].join('\n')
        }],
        structuredContent: data
      };
    } catch (err) {
      return errorResult(err);
    }
  }
);

server.registerTool(
  'gas_audit',
  {
    title: 'Verify a journalled gas decision',
    description:
      'Resolve a decision_id from gas_decision against what Base gas actually did: the real base ' +
      'fee at the target block, whether the forecast range contained it, and whether the recorded ' +
      'stance turned out cheaper. Costs $0.002 in USDC per call. Returns pending if the target ' +
      'block has not been reached yet. This closes the preflight → decision → audit loop.',
    inputSchema: {
      decisionId: z.string().regex(/^[a-f0-9]{32}$/, 'A decision_id is 32 hexadecimal characters')
        .describe('The decision_id returned by gas_decision')
    }
  },
  async ({ decisionId }) => {
    try {
      const { data, settlement, paidUsd } = await paidCall(
        'GET', '/api/v1/gas/audit/' + decisionId
      );

      const lines = data.status === 'pending'
        ? [
            `Decision ${decisionId} is not resolvable yet.`,
            `${data.blocksRemaining} blocks to go (about ${Math.ceil(data.secondsRemaining / 60)} min).`,
            `Target block ${data.targetBlock}, current ${data.currentBlock}.`
          ]
        : [
            `Decision ${decisionId} — stance "${data.stance}" was ${data.stanceOutcome}.`,
            `Forecast range: ${data.forecast.lowGwei}–${data.forecast.highGwei} gwei`,
            `Actual at block ${data.actual.block}: ${data.actual.baseFeeGwei} gwei ` +
              `(${data.changePct > 0 ? '+' : ''}${data.changePct}%)`,
            `Range contained the actual value: ${data.rangeContainedActual}`,
            data.explanation,
            `Verify independently: ${data.verify}`
          ];

      lines.push('', receipt(paidUsd, settlement));
      return { content: [{ type: 'text', text: lines.join('\n') }], structuredContent: data };
    } catch (err) {
      return errorResult(err);
    }
  }
);

server.registerTool(
  'lotus_wallet_status',
  {
    title: 'Check payment wallet and spend caps',
    description:
      'Report the wallet address paying for these tools, how much has been spent this session, ' +
      'and the configured caps. Free — makes no payment. Use this before a run of paid calls, ' +
      'or when a call is refused for exceeding a cap.',
    inputSchema: {}
  },
  async () => ({
    content: [{
      type: 'text',
      text: [
        `Wallet: ${account.address}`,
        `Endpoint: ${BASE_URL}`,
        `Spent this session: $${spentUsd.toFixed(4)} across ${callCount} calls`,
        `Caps: $${MAX_CALL_USD.toFixed(3)} per call, $${MAX_SESSION_USD.toFixed(2)} per session`,
        `Remaining this session: $${Math.max(0, MAX_SESSION_USD - spentUsd).toFixed(4)}`,
        '',
        'Fund this wallet with native USDC on Base (0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913).'
      ].join('\n')
    }]
  })
);

const transport = new StdioServerTransport();
await server.connect(transport);
log('ready on stdio');
