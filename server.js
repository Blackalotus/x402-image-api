import express from 'express';
import crypto from 'crypto';
import { paymentMiddleware, x402ResourceServer } from '@x402/express';
import { HTTPFacilitatorClient } from '@x402/core/server';
import { ExactEvmScheme } from '@x402/evm/exact/server';

const app = express();
app.set('trust proxy', true);
app.use(express.json());

const WALLET_ADDRESS = '0x3268C9434D8603957420f04510CA0ff6097A5C64';
const BASE_URL = process.env.BASE_URL || 'https://x402-image-api.onrender.com';

const REPLICATE_TOKEN = process.env.REPLICATE_API_TOKEN;
const REPLICATE_MODEL = process.env.REPLICATE_MODEL || 'black-forest-labs/flux-schnell';

// ---------------------------------------------------------------------------
// In-memory image cache so a paid result can be re-fetched as real bytes.
// Gives humans a working download and agents a plain URL. Not durable — a
// Render restart clears it, so move to S3/R2 if you need permanence.
// ---------------------------------------------------------------------------
const IMAGE_TTL_MS = 60 * 60 * 1000;
const IMAGE_CACHE_MAX = 50;
const imageCache = new Map();

function cacheImage({ buffer, mimeType, prompt }) {
  const id = crypto.randomBytes(16).toString('hex');
  imageCache.set(id, { buffer, mimeType, prompt, createdAt: Date.now() });

  for (const [key, value] of imageCache) {
    if (Date.now() - value.createdAt > IMAGE_TTL_MS) imageCache.delete(key);
  }
  while (imageCache.size > IMAGE_CACHE_MAX) {
    imageCache.delete(imageCache.keys().next().value);
  }
  return id;
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
        .actions a, .actions button { display: block; text-align: center; text-decoration: none; padding: 11px 8px; border-radius: 8px; background: #334155; color: #e2e8f0; font-weight: 600; font-size: 0.85rem; border: none; cursor: pointer; font-family: inherit; box-sizing: border-box; }
        .actions a:hover, .actions button:hover { background: #475569; }
        .actions .wide { grid-column: 1 / -1; }
        #meta { margin-top: 0.75rem; font-size: 0.75rem; color: #64748b; word-break: break-all; line-height: 1.5; }
        #meta a { color: #38bdf8; }
        #toast { margin-top: 8px; font-size: 0.78rem; color: #4ade80; min-height: 1em; }
      </style>
    </head>
    <body>
      <div class="card">
        <h1>AI Image Generator <span class="badge">x402 V2</span></h1>
        <p>Enter a prompt below. Payment of $0.05 Base USDC will be prompted via your connected wallet.</p>
        <input type="text" id="prompt" placeholder="Type your prompt here..." value="" />
        <button id="btn" onclick="generate()">Generate Image ($0.05 Base USDC)</button>
        <div id="status"></div>

        <div id="result">
          <img id="image" alt="Generated image" />
          <div class="actions">
            <a id="saveBtn" href="#" download>Save image</a>
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
          setTimeout(() => { if (el.innerText === msg) el.innerText = ''; }, 3000);
        }

        // The clipboard API only accepts PNG, and the model returns webp — so
        // redraw through a canvas. Done eagerly on load, because Safari kills
        // the click's user activation if we await anything before write().
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
          });
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
              btn.innerText = 'Share / Save image';
              toast('Clipboard blocked here — tap again to share', true);
            });
        }

        async function shareImage() {
          try {
            const blob = await pngPromise;
            const slug = ((lastResult && lastResult.prompt) || 'image')
              .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
            const file = new File([blob], (slug || 'image') + '.png', { type: 'image/png' });
            if (navigator.canShare && navigator.canShare({ files: [file] })) {
              return await navigator.share({ files: [file] });
            }
            throw new Error('unsupported');
          } catch (err) {
            if (err && err.name === 'AbortError') return;
            toast('Use "Save image", or long-press the image above', true);
          }
        }

        async function copyLink() {
          if (!lastResult) return;
          const link = window.location.origin + lastResult.imageUrl;
          try {
            await navigator.clipboard.writeText(link);
            toast('Link copied — valid for 1 hour');
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

            const ext = (data.mimeType || 'image/webp').split('/')[1] || 'webp';
            const slug = promptInput.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);

            imgEl.src = 'data:' + (data.mimeType || 'image/webp') + ';base64,' + data.image;
            preparePng();

            // Download from the real endpoint, not the data URL — mobile
            // browsers handle Content-Disposition far better than data: links.
            const saveBtn = document.getElementById('saveBtn');
            saveBtn.href = data.imageUrl + '?download=1';
            saveBtn.setAttribute('download', (slug || 'image') + '.' + ext);

            const tx = settlement && settlement.transaction;
            metaEl.innerHTML = 'Prompt: ' + (data.prompt || '') + '<br>Model: ' + (data.model || '') +
              (tx ? '<br>Tx: <a href="https://basescan.org/tx/' + tx + '" target="_blank" rel="noopener">' + tx + '</a>' : '');
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
// 2. Facilitator client + resource server
// ---------------------------------------------------------------------------
const facilitatorClient = new HTTPFacilitatorClient({
  url: process.env.FACILITATOR_URL || 'https://facilitator.payai.network'
});

const x402Server = new x402ResourceServer(facilitatorClient);
x402Server.register('eip155:8453', new ExactEvmScheme());

// ---------------------------------------------------------------------------
// 3. Retrieval endpoint — registered BEFORE the payment middleware so an
//    already-paid-for image can be fetched again without paying twice.
//    The 128-bit random id is the access credential.
// ---------------------------------------------------------------------------
app.get('/api/v1/image/:id', (req, res) => {
  const entry = imageCache.get(req.params.id);
  if (!entry || Date.now() - entry.createdAt > IMAGE_TTL_MS) {
    imageCache.delete(req.params.id);
    return res.status(404).json({ error: 'Image expired or not found. Images are kept for 1 hour.' });
  }

  const ext = entry.mimeType.split('/')[1] || 'webp';
  res.set('Content-Type', entry.mimeType);
  res.set('Cache-Control', 'private, max-age=3600');
  if (req.query.download !== undefined) {
    const slug = (entry.prompt || 'image').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
    res.set('Content-Disposition', `attachment; filename="${slug || 'image'}.${ext}"`);
  }
  res.send(entry.buffer);
});

// ---------------------------------------------------------------------------
// 4. Diagnostics, then route protection
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

const routes = {
  'GET /api/v1/generate-image': {
    accepts: [
      {
        scheme: 'exact',
        price: '$0.05',
        network: 'eip155:8453',
        payTo: WALLET_ADDRESS
      }
    ],
    description: 'AI image generation, one prompt',
    mimeType: 'application/json'
  }
};

app.use(paymentMiddleware(routes, x402Server));

// ---------------------------------------------------------------------------
// 5. Image generation via Replicate
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
// 6. Protected route — only reached after the payment settles.
//    ?format=binary returns raw image bytes for agents that would rather not
//    decode base64 out of JSON.
// ---------------------------------------------------------------------------
app.get('/api/v1/generate-image', async (req, res) => {
  const prompt = (req.query.prompt || '').toString().trim();
  if (!prompt) return res.status(400).json({ error: 'Missing prompt' });

  try {
    console.log(`[gen] generating: "${prompt}"`);
    const { buffer, mimeType } = await replicateGenerate(prompt);
    const id = cacheImage({ buffer, mimeType, prompt });
    console.log(`[gen] done: ${id}, ${Math.round(buffer.length / 1024)} KB`);

    if (req.query.format === 'binary') {
      res.set('Content-Type', mimeType);
      res.set('X-Image-Url', `${BASE_URL}/api/v1/image/${id}`);
      return res.send(buffer);
    }

    res.json({
      success: true,
      prompt,
      model: REPLICATE_MODEL,
      mimeType,
      image: buffer.toString('base64'),
      imageUrl: `/api/v1/image/${id}`,
      absoluteUrl: `${BASE_URL}/api/v1/image/${id}`,
      downloadUrl: `${BASE_URL}/api/v1/image/${id}?download=1`,
      expiresInSeconds: IMAGE_TTL_MS / 1000
    });
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
    replicate: Boolean(REPLICATE_TOKEN),
    model: REPLICATE_MODEL,
    cachedImages: imageCache.size
  })
);

app.use((err, req, res, next) => {
  console.error('[x402] middleware error:', err);
  res.status(err.status || 500).json({ error: err.message || String(err) });
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server running on port ${PORT} (x402 V2 + Replicate)`));