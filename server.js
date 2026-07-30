import express from 'express';
import crypto from 'crypto';
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

const app = express();
app.set('trust proxy', true);
app.use(express.json());

const WALLET_ADDRESS = process.env.PAY_TO_ADDRESS || '0x3268C9434D8603957420f04510CA0ff6097A5C64';
const BASE_URL = process.env.BASE_URL || 'https://lotusnetworkapi.com';

const REPLICATE_TOKEN = process.env.REPLICATE_API_TOKEN;
const REPLICATE_MODEL = process.env.REPLICATE_MODEL || 'black-forest-labs/flux-schnell';

const CDP_KEY_ID = process.env.CDP_API_KEY_ID;
const CDP_KEY_SECRET = process.env.CDP_API_KEY_SECRET;

const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID;
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
const R2_BUCKET = process.env.R2_BUCKET || 'x402-images';
const RETENTION_DAYS = Number(process.env.IMAGE_RETENTION_DAYS || 30);

const PRICE_USD = process.env.PRICE_USD || '0.05';

// ---------------------------------------------------------------------------
// Storage. R2 is the durable store; a small in-process LRU sits in front so
// repeat views of a fresh image don't round-trip to object storage.
//
// If R2 isn't configured the server still works, but images live only in
// memory and die on restart — fine for local dev, not for handing out links.
// ---------------------------------------------------------------------------
const r2Enabled = Boolean(R2_ACCOUNT_ID && R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY);

const r2 = r2Enabled
  ? new S3Client({
      region: 'auto',
      endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: R2_ACCESS_KEY_ID,
        secretAccessKey: R2_SECRET_ACCESS_KEY
      }
    })
  : null;

if (!r2Enabled) {
  console.warn('[storage] R2 not configured — image URLs will break on restart. Set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY.');
}

const HOT_CACHE_MAX = 30;
const hotCache = new Map();

function hotSet(id, entry) {
  hotCache.set(id, entry);
  while (hotCache.size > HOT_CACHE_MAX) {
    hotCache.delete(hotCache.keys().next().value);
  }
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
      Bucket: R2_BUCKET,
      Key: key,
      Body: buffer,
      ContentType: mimeType,
      // R2 object metadata must be ASCII; prompts can contain anything.
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

  // The id alone doesn't encode the extension, so try the plausible ones.
  for (const ext of ['webp', 'png', 'jpeg', 'jpg']) {
    try {
      const result = await r2.send(new GetObjectCommand({
        Bucket: R2_BUCKET,
        Key: `images/${id}.${ext}`
      }));

      const bytes = await result.Body.transformToByteArray();
      const entry = {
        buffer: Buffer.from(bytes),
        mimeType: result.ContentType || `image/${ext}`,
        prompt: result.Metadata && result.Metadata.prompt
          ? decodeURIComponent(result.Metadata.prompt)
          : 'image',
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
      <title>AI Image Studio | x402 Micropayments</title>
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0f172a; color: #fff; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; padding: 1rem; }
        .card { background: #1e293b; padding: 2rem; border-radius: 12px; max-width: 480px; width: 100%; border: 1px solid #334155; }
        h1 { font-size: 1.5rem; margin-bottom: 0.5rem; }
        p { color: #94a3b8; font-size: 0.9rem; margin-bottom: 1.5rem; }
        .badge { background: #2563eb; color: #fff; padding: 4px 10px; border-radius: 999px; font-size: 0.75rem; font-weight: bold; }
        input { width: 100%; padding: 12px; border-radius: 8px; border: 1px solid #475569; background: #0f172a; color: #fff; margin-bottom: 1rem; box-sizing: border-box; }
        button { width: 100%; padding: 12px; border-radius: 8px; border: none; background: #2563eb; color: #fff; font-weight: bold; cursor: pointer; transition: 0.2s; font-size: 1rem; font-family: inherit; }
        button:hover { background: #1d4ed8; }
        button:disabled { background: #334155; cursor: not-allowed; }
        #status { margin-top: 1rem; font-size: 0.85rem; color: #38bdf8; word-break: break-all; white-space: pre-wrap; }
        .error { color: #ef4444 !important; font-weight: bold; }
        .success { color: #4ade80 !important; font-weight: bold; }
        #result { margin-top: 1.25rem; display: none; }
        #result img { width: 100%; border-radius: 10px; border: 1px solid #334155; display: block; }
        .actions { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 12px; }
        .actions button { display: block; text-align: center; padding: 11px 8px; border-radius: 8px; background: #334155; color: #e2e8f0; font-weight: 600; font-size: 0.85rem; border: none; cursor: pointer; font-family: inherit; box-sizing: border-box; }
        .actions button:hover { background: #475569; }
        .actions .wide { grid-column: 1 / -1; }
        #meta { margin-top: 0.75rem; font-size: 0.75rem; color: #64748b; word-break: break-all; line-height: 1.5; }
        #meta a { color: #38bdf8; }
        #toast { margin-top: 8px; font-size: 0.78rem; color: #4ade80; min-height: 1em; }
      </style>
    </head>
    <body>
      <div class="card">
        <h1>AI Image Generator <span class="badge">x402 V2</span></h1>
        <p>Enter a prompt below. Payment of $${PRICE_USD} Base USDC will be prompted via your connected wallet.</p>
        <input type="text" id="prompt" placeholder="Type your prompt here..." value="" />
        <button id="btn" onclick="generate()">Generate Image ($${PRICE_USD} Base USDC)</button>
        <div id="status"></div>

        <div id="result">
          <img id="image" alt="Generated image" />
          <div class="actions">
            <button id="saveBtn" onclick="saveImage()">Save image</button>
            <button id="copyImgBtn" onclick="copyImage()">Copy image</button>
            <button id="copyLinkBtn" class="wide" onclick="copyLink()">Copy shareable link</button>
          </div>
          <div id="toast"></div>
          <div id="meta"></div>
        </div>
      </div>

      <script>
        let lastResult = null;
        let pngPromise = null;
        let pngBlob = null;
        let clipboardBlocked = false;

        function randomNonce() {
          const bytes = new Uint8Array(32);
          window.crypto.getRandomValues(bytes);
          return '0x' + Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
        }

        function b64ToJson(value) {
          try { return JSON.parse(decodeURIComponent(escape(atob(value)))); }
          catch (e) { try { return JSON.parse(atob(value)); } catch (e2) { return null; } }
        }

        function jsonToB64(obj) {
          return btoa(unescape(encodeURIComponent(JSON.stringify(obj))));
        }

        function toast(msg, bad) {
          const el = document.getElementById('toast');
          el.style.color = bad ? '#ef4444' : '#4ade80';
          el.innerText = msg;
          setTimeout(() => { if (el.innerText === msg) el.innerText = ''; }, 4000);
        }

        function slugify(text) {
          return (text || 'image').toLowerCase()
            .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'image';
        }

        const IS_APPLE = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
          (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

        // The clipboard API only accepts PNG, and the model returns webp — so
        // redraw through a canvas. Done eagerly on load, because Safari kills
        // the click's user activation if we await anything before write().
        // The resolved blob is also kept in pngBlob so saveImage() needs no await.
        function preparePng() {
          const img = document.getElementById('image');
          pngPromise = img.decode().then(() => {
            const canvas = document.createElement('canvas');
            canvas.width = img.naturalWidth;
            canvas.height = img.naturalHeight;
            canvas.getContext('2d').drawImage(img, 0, 0);
            return new Promise((resolve, reject) =>
              canvas.toBlob(b => (b ? resolve(b) : reject(new Error('encode failed'))), 'image/png')
            );
          }).then(blob => { pngBlob = blob; return blob; });
        }

        function openInTab() {
          if (!lastResult || !lastResult.imageUrl) return;
          window.open(lastResult.imageUrl, '_blank');
          toast('Opened full size — long-press it and choose "Add to Photos"');
        }

        function saveImage() {
          if (!lastResult) return;
          const name = slugify(lastResult.prompt) + '.png';

          if (pngBlob) {
            const file = new File([pngBlob], name, { type: 'image/png' });

            // iOS ignores the download attribute entirely; the share sheet is
            // the only real path into Photos.
            if (IS_APPLE && navigator.canShare && navigator.canShare({ files: [file] })) {
              navigator.share({ files: [file] })
                .catch(err => { if (err && err.name !== 'AbortError') openInTab(); });
              return;
            }

            // Android and desktop honour a blob URL + download attribute.
            try {
              const url = URL.createObjectURL(pngBlob);
              const a = document.createElement('a');
              a.href = url;
              a.download = name;
              document.body.appendChild(a);
              a.click();
              a.remove();
              setTimeout(() => URL.revokeObjectURL(url), 10000);
              toast('Saved to your downloads');
              return;
            } catch (e) {}
          }

          openInTab();
        }

        function copyImage() {
          if (!pngPromise) return;
          const btn = document.getElementById('copyImgBtn');

          if (clipboardBlocked || !navigator.clipboard || !window.ClipboardItem) {
            return shareImage();
          }

          // Synchronous call inside the click. Handing ClipboardItem a promise
          // rather than an awaited blob preserves transient user activation.
          navigator.clipboard.write([new ClipboardItem({ 'image/png': pngPromise })])
            .then(() => toast('Image copied to clipboard'))
            .catch(() => {
              clipboardBlocked = true;
              btn.innerText = 'Share image';
              toast('Clipboard blocked here — tap again to share', true);
            });
        }

        async function shareImage() {
          try {
            const blob = pngBlob || await pngPromise;
            const file = new File([blob], slugify(lastResult && lastResult.prompt) + '.png', { type: 'image/png' });
            if (navigator.canShare && navigator.canShare({ files: [file] })) {
              return await navigator.share({ files: [file] });
            }
            throw new Error('unsupported');
          } catch (err) {
            if (err && err.name === 'AbortError') return;
            openInTab();
          }
        }

        async function copyLink() {
          if (!lastResult) return;
          const link = lastResult.absoluteUrl ||
            (lastResult.imageUrl ? window.location.origin + lastResult.imageUrl : null);
          if (!link) return toast('No stored URL for this image', true);
          try {
            await navigator.clipboard.writeText(link);
            toast('Link copied');
          } catch (err) {
            toast('Could not copy: ' + link, true);
          }
        }

        async function generate() {
          const promptInput = document.getElementById('prompt').value.trim();
          const statusDiv = document.getElementById('status');
          const btn = document.getElementById('btn');
          const resultDiv = document.getElementById('result');
          const imgEl = document.getElementById('image');
          const metaEl = document.getElementById('meta');
          const fail = (msg) => { statusDiv.className = 'error'; statusDiv.innerText = msg; };

          if (!promptInput) return fail('Please enter a prompt first.');
          if (!window.ethereum) return fail('No Web3 wallet detected. Open this page inside MetaMask, Coinbase Wallet, or Phantom.');

          const endpoint = '/api/v1/generate-image?prompt=' + encodeURIComponent(promptInput);
          statusDiv.className = '';
          resultDiv.style.display = 'none';
          btn.disabled = true;

          // Reset per-run state so stale buttons can't act on an old image.
          lastResult = null;
          pngPromise = null;
          pngBlob = null;
          clipboardBlocked = false;
          document.getElementById('copyImgBtn').innerText = 'Copy image';

          try {
            // --- Step 1: unpaid request to receive the 402 challenge ----------
            statusDiv.innerText = '1/5 Requesting payment terms...';
            const probe = await fetch(endpoint);

            if (probe.status !== 402) {
              const body = await probe.text();
              if (probe.ok) {
                statusDiv.className = 'success';
                statusDiv.innerText = 'Served without payment — middleware is not gating this route:\\n' + body;
                return;
              }
              throw new Error('Expected 402, got ' + probe.status + ': ' + body);
            }

            const headerValue = probe.headers.get('PAYMENT-REQUIRED');
            let challenge = headerValue ? b64ToJson(headerValue) : null;
            if (!challenge) {
              try { challenge = await probe.clone().json(); } catch (e) { challenge = null; }
            }
            if (!challenge) throw new Error('402 received but no PAYMENT-REQUIRED header and no parseable body.');

            const options = challenge.accepts || [];
            const chosen = options.find(o => o.scheme === 'exact' && String(o.network || '').includes('8453'));
            if (!chosen) throw new Error('No exact/Base option in challenge: ' + JSON.stringify(challenge));

            const chainId = parseInt(String(chosen.network).split(':').pop(), 10);
            const amount = String(chosen.amount ?? chosen.maxAmountRequired);
            const asset = chosen.asset;
            const extra = chosen.extra || {};
            const tokenName = extra.name || 'USD Coin';
            const tokenVersion = extra.version || '2';
            const timeout = chosen.maxTimeoutSeconds || 600;

            if (!amount || amount === 'undefined' || !asset) {
              throw new Error('Challenge missing amount/asset: ' + JSON.stringify(chosen));
            }

            // --- Step 2: connect wallet and ensure it is on Base --------------
            statusDiv.innerText = '2/5 Connecting wallet...';
            const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
            const userAddress = accounts[0];

            const wantHex = '0x' + chainId.toString(16);
            let current = await window.ethereum.request({ method: 'eth_chainId' });
            if (current !== wantHex) {
              try {
                await window.ethereum.request({
                  method: 'wallet_switchEthereumChain',
                  params: [{ chainId: wantHex }]
                });
              } catch (switchErr) {
                if (switchErr.code === 4902) {
                  await window.ethereum.request({
                    method: 'wallet_addEthereumChain',
                    params: [{
                      chainId: '0x2105',
                      chainName: 'Base',
                      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
                      rpcUrls: ['https://mainnet.base.org'],
                      blockExplorerUrls: ['https://basescan.org']
                    }]
                  });
                } else {
                  throw new Error('Wallet would not switch to Base: ' + (switchErr.message || switchErr.code));
                }
              }
              current = await window.ethereum.request({ method: 'eth_chainId' });
              if (current !== wantHex) throw new Error('Wallet is on ' + current + ', needs ' + wantHex + ' (Base).');
            }

            // --- Step 3: sign the EIP-3009 transferWithAuthorization ----------
            statusDiv.innerText = '3/5 Confirming USDC authorization in wallet...';
            const now = Math.floor(Date.now() / 1000);

            const authorization = {
              from: userAddress,
              to: chosen.payTo,
              value: amount,
              validAfter: String(now - 300),
              validBefore: String(now + timeout),
              nonce: randomNonce()
            };

            const typedData = {
              domain: { name: tokenName, version: tokenVersion, chainId: chainId, verifyingContract: asset },
              types: {
                EIP712Domain: [
                  { name: 'name', type: 'string' },
                  { name: 'version', type: 'string' },
                  { name: 'chainId', type: 'uint256' },
                  { name: 'verifyingContract', type: 'address' }
                ],
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
              message: authorization
            };

            const signature = await window.ethereum.request({
              method: 'eth_signTypedData_v4',
              params: [userAddress, JSON.stringify(typedData)]
            });

            // --- Step 4/5: retry with PAYMENT-SIGNATURE, wait for the image ---
            statusDiv.innerText = '4/5 Settling payment...\\n5/5 Generating image (this can take 10-30s)...';

            const paymentPayload = {
              x402Version: challenge.x402Version ?? 2,
              accepted: {
                scheme: chosen.scheme,
                network: chosen.network,
                amount: amount,
                asset: asset,
                payTo: chosen.payTo,
                maxTimeoutSeconds: timeout,
                extra: {
                  assetTransferMethod: extra.assetTransferMethod || 'eip3009',
                  name: tokenName,
                  version: tokenVersion
                }
              },
              payload: { signature, authorization }
            };

            // Echo the server's extensions back. The Bazaar indexer reads its
            // discovery block out of the client's payload, so dropping this
            // would keep the service out of the catalog.
            if (challenge.extensions) paymentPayload.extensions = challenge.extensions;

            if (chosen.resource || chosen.description || chosen.mimeType) {
              paymentPayload.resource = {
                url: chosen.resource || (window.location.origin + endpoint.split('?')[0]),
                description: chosen.description || '',
                mimeType: chosen.mimeType || 'application/json'
              };
            }

            const paid = await fetch(endpoint, {
              headers: { 'PAYMENT-SIGNATURE': jsonToB64(paymentPayload) }
            });

            const rawBody = await paid.text();
            const settleHeader = paid.headers.get('PAYMENT-RESPONSE');
            const settlement = settleHeader ? b64ToJson(settleHeader) : null;

            if (!paid.ok) {
              let detail = rawBody;
              try {
                const parsed = JSON.parse(rawBody);
                detail = parsed.error || parsed.errorReason || parsed.message || rawBody;
              } catch (e) {}
              if (settlement) detail += '\\nSettlement: ' + JSON.stringify(settlement);
              throw new Error('HTTP ' + paid.status + ' — ' + detail);
            }

            const data = JSON.parse(rawBody);
            if (!data.image) throw new Error('Paid successfully but no image returned: ' + rawBody);

            lastResult = data;

            imgEl.src = 'data:' + (data.mimeType || 'image/webp') + ';base64,' + data.image;
            preparePng();

            const tx = settlement && settlement.transaction;
            metaEl.innerHTML = 'Prompt: ' + (data.prompt || '') + '<br>Model: ' + (data.model || '') +
              (tx ? '<br>Tx: <a href="https://basescan.org/tx/' + tx + '" target="_blank" rel="noopener">' + tx + '</a>' : '') +
              (data.storageWarning ? '<br>Note: ' + data.storageWarning : '');
            resultDiv.style.display = 'block';

            statusDiv.className = 'success';
            statusDiv.innerText = 'Paid and generated.';
          } catch (err) {
            fail('Error: ' + (err.message || JSON.stringify(err)));
            console.error(err);
          } finally {
            btn.disabled = false;
          }
        }
      </script>
    </body>
    </html>
  `);
});

// ---------------------------------------------------------------------------
// 2. OpenAPI discovery document.
//    x402scan and similar indexes fetch /openapi.json to register the resource
//    and then verify the runtime 402 behaviour matches. This is a separate
//    mechanism from the Bazaar extension below, which serves CDP/agentic.market.
// ---------------------------------------------------------------------------
app.get('/openapi.json', (req, res) => {
  res.json({
    openapi: '3.0.3',
    info: {
      title: 'AI Image Studio',
      description:
        'Text-to-image generation powered by FLUX. Pay per image in USDC on Base. ' +
        'No API key, account, or subscription.',
            version: '1.0.0',
      contact: { email: 'blacklotusfinance.pls@gmail.com' }

    },
    servers: [{ url: BASE_URL }],
    paths: {
      '/api/v1/generate-image': {
        get: {
          operationId: 'generateImage',
          summary: 'Generate an image from a text prompt',
          tags: ['Media'],
          'x-payment-info': {
            price: { mode: 'fixed', currency: 'USD', amount: Number(PRICE_USD).toFixed(6) },
            protocols: [{ x402: {} }]
          },
          parameters: [
            {
              name: 'prompt',
              in: 'query',
              required: true,
              description: 'Text description of the image to generate',
              schema: { type: 'string' },
              example: 'a cyberpunk city skyline at dusk, neon reflections'
            },
            {
              name: 'format',
              in: 'query',
              required: false,
              description: 'json returns base64 plus a durable URL; binary returns raw image bytes',
              schema: { type: 'string', enum: ['json', 'binary'], default: 'json' }
            }
          ],
          responses: {
            200: {
              description: 'Generated image',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      success: { type: 'boolean' },
                      prompt: { type: 'string' },
                      model: { type: 'string' },
                      mimeType: { type: 'string' },
                      image: { type: 'string', description: 'Base64-encoded image' },
                      absoluteUrl: { type: 'string', description: 'Durable image URL' },
                      downloadUrl: { type: 'string' },
                      retentionDays: { type: 'number' }
                    },
                    required: ['success', 'image']
                  },
                  example: {
                    success: true,
                    prompt: 'a cyberpunk city skyline at dusk, neon reflections',
                    model: 'black-forest-labs/flux-schnell',
                    mimeType: 'image/webp',
                    image: '<base64>',
                    absoluteUrl: `${BASE_URL}/api/v1/image/9f2c4a1e7b3d5f8091a2b3c4d5e6f708`
                  }
                }
              }
            },
            402: {
              description: 'Payment required. Terms are in the PAYMENT-REQUIRED response header.'
            }
          }
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Facilitator client + resource server
//
//    Bazaar indexing only happens when the CDP facilitator settles a payment
//    for a route that declares discovery metadata. Settling through any other
//    facilitator means Coinbase never sees the traffic and the service never
//    appears on agentic.market.
// ---------------------------------------------------------------------------
const usingCdp = Boolean(CDP_KEY_ID && CDP_KEY_SECRET);

if (!usingCdp) {
  console.warn(
    '[x402] CDP_API_KEY_ID / CDP_API_KEY_SECRET missing — falling back to PayAI. ' +
    'Payments will work but the service will NOT be indexed for agentic.market.'
  );
}

const facilitatorClient = usingCdp
  ? withBazaar(new HTTPFacilitatorClient(createFacilitatorConfig(CDP_KEY_ID, CDP_KEY_SECRET)))
  : new HTTPFacilitatorClient({ url: process.env.FACILITATOR_URL || 'https://facilitator.payai.network' });

const x402Server = new x402ResourceServer(facilitatorClient);
x402Server.register('eip155:8453', new ExactEvmScheme());

if (usingCdp) {
  x402Server.registerExtension(bazaarResourceServerExtension);
}

// ---------------------------------------------------------------------------
// 4. Retrieval endpoint — registered BEFORE the payment middleware so an
//    already-paid-for image can be fetched again without paying twice.
//    The 128-bit random id is the access credential.
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
    console.log(`[x402] ${req.method} ${req.originalUrl} — no PAYMENT-SIGNATURE, issuing 402`);
  } else {
    if (req.headers['x-payment'] && !req.headers['payment-signature']) {
      console.warn('[x402] client sent V1 X-PAYMENT; V2 middleware expects PAYMENT-SIGNATURE');
    }
    try {
      console.log('[x402] inbound payload:', Buffer.from(sig, 'base64').toString('utf8'));
    } catch (e) {
      console.warn('[x402] payment header is not valid base64');
    }
  }
  next();
});

// Discovery metadata. This is what the Bazaar indexes and what agents read to
// decide whether to call the endpoint, so the description and examples matter.
const discovery = declareDiscoveryExtension({
  input: { prompt: 'a cyberpunk city skyline at dusk, neon reflections' },
  inputSchema: {
    properties: {
      prompt: {
        type: 'string',
        description: 'Text description of the image to generate'
      },
      format: {
        type: 'string',
        enum: ['json', 'binary'],
        description: 'json returns base64 plus a durable URL; binary returns raw image bytes'
      }
    },
    required: ['prompt']
  },
  output: {
    example: {
      success: true,
      prompt: 'a cyberpunk city skyline at dusk, neon reflections',
      model: 'black-forest-labs/flux-schnell',
      mimeType: 'image/webp',
      image: '<base64-encoded image bytes>',
      absoluteUrl: `${BASE_URL}/api/v1/image/9f2c4a1e7b3d5f8091a2b3c4d5e6f708`
    },
    schema: {
      properties: {
        success: { type: 'boolean' },
        prompt: { type: 'string' },
        model: { type: 'string' },
        mimeType: { type: 'string' },
        image: { type: 'string', description: 'Base64-encoded image' },
        absoluteUrl: { type: 'string', description: 'Durable image URL' },
        downloadUrl: { type: 'string' },
        retentionDays: { type: 'number' }
      }
    }
  }
});

const routes = {
  'GET /api/v1/generate-image': {
    accepts: [
      {
        scheme: 'exact',
        price: `$${PRICE_USD}`,
        network: 'eip155:8453',
        payTo: WALLET_ADDRESS
      }
    ],
    description:
      'Text-to-image generation powered by FLUX. Send a prompt, get back a 1024x1024 image as ' +
      'base64 JSON or raw bytes, plus a durable direct URL. No API key or account needed.',
    mimeType: 'application/json',
    extensions: { ...discovery }
  }
};

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
          prompt,
          num_outputs: 1,
          aspect_ratio: '1:1',
          output_format: 'webp',
          output_quality: 90
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
// 7. Protected route — only reached after the payment settles.
//    ?format=binary returns raw image bytes for agents that would rather not
//    decode base64 out of JSON.
// ---------------------------------------------------------------------------
app.get('/api/v1/generate-image', async (req, res) => {
  const prompt = (req.query.prompt || '').toString().trim();
  if (!prompt) return res.status(400).json({ error: 'Missing prompt' });

  try {
    console.log(`[gen] generating: "${prompt}"`);
    const { buffer, mimeType } = await replicateGenerate(prompt);

    // Store before responding, but never fail the request over it — the caller
    // has already paid, so they get their image inline either way. Only the
    // durable URL is lost if the upload fails.
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
      success: true,
      prompt,
      model: REPLICATE_MODEL,
      mimeType,
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
      error: 'Payment settled but image generation failed: ' + err.message,
      prompt
    });
  }
});

app.get('/healthz', (req, res) =>
  res.json({
    ok: true,
    protocol: 'x402 v2',
    baseUrl: BASE_URL,
    price: PRICE_USD,
    facilitator: usingCdp ? 'cdp' : 'payai',
    bazaarEnabled: usingCdp,
    payTo: WALLET_ADDRESS,
    replicate: Boolean(REPLICATE_TOKEN),
    model: REPLICATE_MODEL,
    storage: r2Enabled ? 'r2' : 'memory-only',
    bucket: r2Enabled ? R2_BUCKET : null,
    retentionDays: RETENTION_DAYS,
    hotCache: hotCache.size
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
});
