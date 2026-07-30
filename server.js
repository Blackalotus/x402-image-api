import express from 'express';
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
// 1. Human UI homepage
//
//    x402 V2 protocol notes baked into this client:
//      - Requirements arrive in the base64 PAYMENT-REQUIRED response header.
//      - The client retries with PAYMENT-SIGNATURE (X-PAYMENT is V1).
//      - The PaymentPayload echoes back an `accepted` object plus
//        payload.{signature, authorization}.
//      - Settlement result comes back in the PAYMENT-RESPONSE header.
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
        button { width: 100%; padding: 12px; border-radius: 8px; border: none; background: #2563eb; color: #fff; font-weight: bold; cursor: pointer; transition: 0.2s; }
        button:hover { background: #1d4ed8; }
        button:disabled { background: #334155; cursor: not-allowed; }
        #status { margin-top: 1rem; font-size: 0.85rem; color: #38bdf8; word-break: break-all; white-space: pre-wrap; }
        .error { color: #ef4444 !important; font-weight: bold; }
        .success { color: #4ade80 !important; font-weight: bold; }
        #result { margin-top: 1.25rem; display: none; }
        #result img { width: 100%; border-radius: 10px; border: 1px solid #334155; display: block; }
        #meta { margin-top: 0.75rem; font-size: 0.75rem; color: #64748b; word-break: break-all; }
        #meta a { color: #38bdf8; }
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
          <div id="meta"></div>
        </div>
      </div>

      <script>
        function randomNonce() {
          const bytes = new Uint8Array(32);
          window.crypto.getRandomValues(bytes);
          return '0x' + Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
        }

        function b64ToJson(value) {
          try {
            return JSON.parse(decodeURIComponent(escape(atob(value))));
          } catch (e) {
            try { return JSON.parse(atob(value)); } catch (e2) { return null; }
          }
        }

        function jsonToB64(obj) {
          return btoa(unescape(encodeURIComponent(JSON.stringify(obj))));
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

            imgEl.src = 'data:' + (data.mimeType || 'image/webp') + ';base64,' + data.image;
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
// 3. Diagnostics, then route protection
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
// 4. Image generation via Replicate
//    Uses the official-model endpoint with `Prefer: wait` so the request
//    blocks until the prediction finishes, then polls if it needs longer.
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

  if (!created.ok) {
    throw new Error(`Replicate ${created.status}: ${await created.text()}`);
  }

  let prediction = await created.json();

  // Poll if `Prefer: wait` returned before the prediction finished.
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

  const buffer = Buffer.from(await file.arrayBuffer());
  return {
    base64: buffer.toString('base64'),
    mimeType: file.headers.get('content-type') || 'image/webp',
    url: imageUrl
  };
}

// ---------------------------------------------------------------------------
// 5. Protected route — only reached after the payment settles
// ---------------------------------------------------------------------------
app.get('/api/v1/generate-image', async (req, res) => {
  const prompt = (req.query.prompt || '').toString().trim();
  if (!prompt) return res.status(400).json({ error: 'Missing prompt' });

  try {
    console.log(`[gen] generating: "${prompt}"`);
    const image = await replicateGenerate(prompt);
    console.log(`[gen] done, ${Math.round(image.base64.length / 1365)} KB`);

    res.json({
      success: true,
      prompt,
      model: REPLICATE_MODEL,
      mimeType: image.mimeType,
      image: image.base64,
      sourceUrl: image.url
    });
  } catch (err) {
    // NOTE: the payment has already settled by the time we get here. Log
    // enough to honour a manual retry or refund for the payer.
    console.error('[gen] FAILED AFTER PAYMENT:', prompt, err);
    res.status(502).json({
      error: 'Payment settled but image generation failed: ' + err.message,
      prompt
    });
  }
});

app.get('/healthz', (req, res) =>
  res.json({ ok: true, protocol: 'x402 v2', replicate: Boolean(REPLICATE_TOKEN), model: REPLICATE_MODEL })
);

app.use((err, req, res, next) => {
  console.error('[x402] middleware error:', err);
  res.status(err.status || 500).json({ error: err.message || String(err) });
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server running on port ${PORT} (x402 V2 + Replicate)`));