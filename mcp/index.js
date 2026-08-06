#!/usr/bin/env node
/**
 * Lotus Network MCP server — secure remote mode
 *
 * This server never holds a private key and never signs a payment. Each
 * paid tool works in two steps:
 *
 *   1. get_X_terms       -> probes the real endpoint, returns EIP-712 typed
 *                            data for the caller's OWN wallet to sign.
 *   2. submit_signed_payment -> takes a finished signature (never a key),
 *                            forwards it, returns the real result.
 *
 * Transport: if running on a host (PORT/RENDER is set), this runs as a network server
 * over Streamable HTTP so any agent on the internet can connect. Otherwise
 * it falls back to stdio, for local use in Claude Desktop / Cursor.
 *
 * Never write to stdout in stdio mode: it carries the JSON-RPC stream.
 * Log to stderr always.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express from 'express';
import { z } from 'zod';
import { randomBytes } from 'node:crypto';

const BASE_URL = (process.env.LOTUS_API_URL || 'https://lotusnetworkapi.com').replace(/\/$/, '');
const log = (...args) => console.error('[lotus-mcp]', ...args);

log(`target ${BASE_URL}`);
log('mode: secure two-step signing — this server never holds a private key.');

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------
function b64ToJson(value) {
  return JSON.parse(Buffer.from(value, 'base64').toString('utf8'));
}
function jsonToB64(obj) {
  return Buffer.from(JSON.stringify(obj), 'utf8').toString('base64');
}

// Step 1: probe the endpoint, read the 402 challenge, build typed data for
// the CALLER to sign. No money moves. No key involved.
async function requestTerms(method, path, body) {
  const url = BASE_URL + path;
  const init = { method };
  if (body) {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = JSON.stringify(body);
  }

  const probe = await fetch(url, init);
  if (probe.status !== 402) {
    const text = await probe.text();
    throw new Error(`Expected a 402 challenge, got ${probe.status}: ${text.slice(0, 300)}`);
  }

  const header = probe.headers.get('PAYMENT-REQUIRED');
  let challenge = null;
  if (header) { try { challenge = b64ToJson(header); } catch (e) {} }
  if (!challenge) { try { challenge = await probe.clone().json(); } catch (e) {} }
  if (!challenge) throw new Error('402 received but PAYMENT-REQUIRED could not be read.');

  const chosen = (challenge.accepts || []).find(
    o => o.scheme === 'exact' && String(o.network || '').includes('8453')
  );
  if (!chosen) throw new Error('No exact/Base payment option was offered.');

  const amountAtomic = String(chosen.amount ?? chosen.maxAmountRequired);
  if (!amountAtomic || !chosen.asset) throw new Error('The challenge is missing an amount or asset.');

  const extra = chosen.extra || {};
  const chainId = parseInt(String(chosen.network).split(':').pop(), 10);
  const timeout = chosen.maxTimeoutSeconds || 600;
  const now = Math.floor(Date.now() / 1000);

  const authorization = {
    from: null,                                     // caller fills this in
    to: chosen.payTo,
    value: amountAtomic,
    validAfter: String(now - 300),
    validBefore: String(now + timeout),
    nonce: '0x' + randomBytes(32).toString('hex'),
  };

  const typedData = {
    domain: {
      name: extra.name || 'USD Coin',
      version: extra.version || '2',
      chainId,
      verifyingContract: chosen.asset,
    },
    types: {
      EIP712Domain: [
        { name: 'name', type: 'string' }, { name: 'version', type: 'string' },
        { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' },
      ],
      TransferWithAuthorization: [
        { name: 'from', type: 'address' }, { name: 'to', type: 'address' },
        { name: 'value', type: 'uint256' }, { name: 'validAfter', type: 'uint256' },
        { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' },
      ],
    },
    primaryType: 'TransferWithAuthorization',
    message: authorization,
  };

  const usd = Number(amountAtomic) / 1e6;

  return {
    priceUsd: usd,
    paymentContext: {
      path, method, body: body || null,
      x402Version: challenge.x402Version ?? 2,
      accepted: {
        scheme: chosen.scheme, network: chosen.network, amount: amountAtomic,
        asset: chosen.asset, payTo: chosen.payTo, maxTimeoutSeconds: timeout,
        extra: { assetTransferMethod: extra.assetTransferMethod || 'eip3009',
          name: typedData.domain.name, version: typedData.domain.version },
      },
      resource: challenge.resource || { url, description: '', mimeType: 'application/json' },
    },
    authorization,
    typedData,
  };
}

// Step 2: caller sends back a finished signature. We never see a key.
async function submitSignedPayment(paymentContext, authorization, signature) {
  const paymentPayload = {
    x402Version: paymentContext.x402Version,
    accepted: paymentContext.accepted,
    payload: { signature, authorization },
    resource: paymentContext.resource,
  };

  const init = { method: paymentContext.method,
    headers: { 'PAYMENT-SIGNATURE': jsonToB64(paymentPayload) } };
  if (paymentContext.body) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(paymentContext.body);
  }

  const paid = await fetch(BASE_URL + paymentContext.path, init);
  const rawBody = await paid.text();
  if (!paid.ok) {
    let detail = rawBody;
    try { detail = JSON.parse(rawBody).error || detail; } catch (e) {}
    throw new Error(`HTTP ${paid.status}: ${detail}`);
  }

  const settleHeader = paid.headers.get('PAYMENT-RESPONSE');
  let settlement = null;
  if (settleHeader) { try { settlement = b64ToJson(settleHeader); } catch (e) {} }

  return { data: JSON.parse(rawBody), settlement };
}

function receipt(settlement) {
  const tx = settlement && settlement.transaction;
  return tx ? `Receipt: https://basescan.org/tx/${tx}` : '';
}
function termsResult(priceUsd, paymentContext, authorization, typedData) {
  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        instructions:
          `This call costs $${priceUsd.toFixed(4)} USDC. Sign \`typedData\` with your OWN wallet ` +
          `(EIP-712, TransferWithAuthorization), fill \`authorization.from\` with your address, ` +
          `then call submit_signed_payment with this same paymentContext, your completed ` +
          `authorization, and the signature. Nothing has been charged yet.`,
        priceUsd, paymentContext, authorization, typedData,
      }, null, 2),
    }],
  };
}
function errorResult(err) {
  return { isError: true, content: [{ type: 'text', text: `Lotus Network call failed: ${err.message}` }] };
}

// ---------------------------------------------------------------------------
// MCP server + tools
// ---------------------------------------------------------------------------
function buildServer() {
  const server = new McpServer({ name: 'lotus-network', version: '2.0.0' });

  server.registerTool(
    'generate_image',
    {
      title: 'Get terms: generate an image',
      description:
        'Get payment terms for a 1024x1024 image from a text prompt via FLUX. $0.05 USDC. ' +
        'Returns typed data for YOUR wallet to sign — call submit_signed_payment next.',
      inputSchema: { prompt: z.string().min(1).describe('What the image should show') },
    },
    async ({ prompt }) => {
      try {
        const { priceUsd, paymentContext, authorization, typedData } =
          await requestTerms('GET', '/api/v1/generate-image?prompt=' + encodeURIComponent(prompt));
        return termsResult(priceUsd, paymentContext, authorization, typedData);
      } catch (err) { return errorResult(err); }
    }
  );

  server.registerTool(
    'pdf_to_markdown',
    {
      title: 'Get terms: convert a PDF to Markdown',
      description:
        'Get payment terms to extract a PDF\'s text as Markdown. $0.005 USDC. ' +
        'Returns typed data for YOUR wallet to sign — call submit_signed_payment next.',
      inputSchema: {
        url: z.string().url().optional().describe('Public URL of the PDF'),
        pdfBase64: z.string().optional().describe('Base64-encoded PDF bytes, if no URL'),
        pageMarkers: z.boolean().optional(),
      },
    },
    async ({ url, pdfBase64, pageMarkers }) => {
      try {
        if (!url && !pdfBase64) throw new Error('Provide either url or pdfBase64.');
        const body = {};
        if (url) body.url = url;
        if (pdfBase64) body.pdf = pdfBase64;
        if (pageMarkers) body.pageMarkers = true;
        const { priceUsd, paymentContext, authorization, typedData } =
          await requestTerms('POST', '/api/v1/pdf-to-markdown', body);
        return termsResult(priceUsd, paymentContext, authorization, typedData);
      } catch (err) { return errorResult(err); }
    }
  );

  server.registerTool(
    'gas_preflight',
    {
      title: 'Get terms: check Base gas conditions',
      description:
        'Get payment terms for current Base gas conditions plus an 80% forecast range. $0.002 USDC. ' +
        'Returns typed data for YOUR wallet to sign — call submit_signed_payment next.',
      inputSchema: { horizonMinutes: z.number().int().min(1).max(60).optional() },
    },
    async ({ horizonMinutes }) => {
      try {
        const h = horizonMinutes || 5;
        const { priceUsd, paymentContext, authorization, typedData } =
          await requestTerms('GET', '/api/v1/gas/preflight?horizonMinutes=' + h);
        return termsResult(priceUsd, paymentContext, authorization, typedData);
      } catch (err) { return errorResult(err); }
    }
  );

  server.registerTool(
    'gas_decision',
    {
      title: 'Get terms: journal a gas timing decision',
      description:
        'Get payment terms to record an execute/wait decision against a fresh forecast. $0.003 USDC. ' +
        'Returns typed data for YOUR wallet to sign — call submit_signed_payment next.',
      inputSchema: {
        stance: z.enum(['execute', 'wait']),
        horizonMinutes: z.number().int().min(1).max(60).optional(),
        maxFeeGwei: z.number().optional(),
        note: z.string().max(500).optional(),
      },
    },
    async ({ stance, horizonMinutes, maxFeeGwei, note }) => {
      try {
        const body = { stance };
        if (horizonMinutes) body.horizonMinutes = horizonMinutes;
        if (typeof maxFeeGwei === 'number') body.maxFeeGwei = maxFeeGwei;
        if (note) body.note = note;
        const { priceUsd, paymentContext, authorization, typedData } =
          await requestTerms('POST', '/api/v1/gas/decision', body);
        return termsResult(priceUsd, paymentContext, authorization, typedData);
      } catch (err) { return errorResult(err); }
    }
  );

  server.registerTool(
    'gas_audit',
    {
      title: 'Get terms: verify a journalled gas decision',
      description:
        'Get payment terms to resolve a decision_id against actual chain data. $0.002 USDC. ' +
        'Returns typed data for YOUR wallet to sign — call submit_signed_payment next.',
      inputSchema: {
        decisionId: z.string().regex(/^[a-f0-9]{32}$/, 'A decision_id is 32 hex characters'),
      },
    },
    async ({ decisionId }) => {
      try {
        const { priceUsd, paymentContext, authorization, typedData } =
          await requestTerms('GET', '/api/v1/gas/audit/' + decisionId);
        return termsResult(priceUsd, paymentContext, authorization, typedData);
      } catch (err) { return errorResult(err); }
    }
  );

  server.registerTool(
    'submit_signed_payment',
    {
      title: 'Submit a signed payment and get the result',
      description:
        'Complete any Lotus Network call using a signature YOU produced with your own wallet. ' +
        'This server never receives or stores a private key — only a finished signature.',
      inputSchema: {
        paymentContext: z.record(z.any()).describe('Unchanged from the matching get-terms tool'),
        authorization: z.record(z.any()).describe('The authorization you signed, with `from` filled in'),
        signature: z.string().describe('The EIP-712 signature from your own wallet'),
      },
    },
    async ({ paymentContext, authorization, signature }) => {
      try {
        const { data, settlement } = await submitSignedPayment(paymentContext, authorization, signature);
        const text = typeof data === 'object'
          ? JSON.stringify(data, null, 2) + '\n\n' + receipt(settlement)
          : String(data);
        return { content: [{ type: 'text', text }], structuredContent: data };
      } catch (err) { return errorResult(err); }
    }
  );

  return server;
}

// ---------------------------------------------------------------------------
// Transport: HTTP (live, remote) if PORT/RENDER is set — otherwise stdio (local)
// ---------------------------------------------------------------------------
const PORT = process.env.PORT || 10000;

if (process.env.PORT || process.env.RENDER) {
  const app = express();
  app.use(express.json());

  app.post('/mcp', async (req, res) => {
    try {
      const server = buildServer();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on('close', () => { transport.close(); server.close(); });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      log('request error:', err.message);
      if (!res.headersSent) res.status(500).json({ error: err.message });
    }
  });

  app.get('/healthz', (req, res) => res.json({ ok: true, target: BASE_URL, mode: 'http' }));

  app.listen(PORT, '0.0.0.0', () => log(`live on port ${PORT} — POST /mcp`));
} else {
  const server = buildServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log('ready on stdio');
}
