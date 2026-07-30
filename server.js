import express from 'express';
import { paymentMiddleware, x402ResourceServer } from '@x402/express';
import { HTTPFacilitatorClient } from '@x402/core/server';
import { ExactEvmScheme } from '@x402/evm/exact/server';

const app = express();
app.set('trust proxy', true);
app.use(express.json());

const WALLET_ADDRESS = '0x3268C9434D8603957420f04510CA0ff6097A5C64';
const BASE_URL = process.env.BASE_URL || 'https://x402-image-api.onrender.com';

// ---------------------------------------------------------------------------
// 1. Human UI homepage
//
//    x402 V2 protocol notes baked into this client:
//      - Requirements arrive in the base64 PAYMENT-REQUIRED response header
//        (NOT the JSON body — that was the "accepts: []" failure).
//      - The client retries with PAYMENT-SIGNATURE (NOT X-PAYMENT, which is V1).
//      - The PaymentPayload must echo back an `accepted` object describing the
//        requirement that was chosen, alongside payload.{signature,authorization}.
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
      </style>
    </head>
    <body>
      <div class="card">
        <h1>AI Image Generator <span class="badge">x402 V2</span></h1>
        <p>Enter a prompt below. Payment of $0.05 Base USDC will be prompted via your connected wallet.</p>
        <input type="text" id="prompt" placeholder="Type your prompt here..." value="" />
        <button id="btn" onclick="generate()">Generate Image ($0.05 Base USDC)</button>
        <div id="status"></div>
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
          const fail = (msg) => { statusDiv.className = 'error'; statusDiv.innerText = msg; };

          if (!promptInput) return fail('Please enter a prompt first.');
          if (!window.ethereum) return fail('No Web3 wallet detected. Open this page inside MetaMask, Coinbase Wallet, or Phantom.');

          const endpoint = '/api/v1/generate-image?prompt=' + encodeURIComponent(promptInput);
          statusDiv.className = '';
          btn.disabled = true;

          try {
            // --- Step 1: unpaid request to receive the 402 challenge ----------
            statusDiv.innerText = '1/4 Requesting payment terms...';
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

            // V2: requirements are in the PAYMENT-REQUIRED header.
            // Fall back to the body only for a V1-style server.
            const headerValue = probe.headers.get('PAYMENT-REQUIRED');
            let challenge = headerValue ? b64ToJson(headerValue) : null;
            if (!challenge) {
              try { challenge = await probe.clone().json(); } catch (e) { challenge = null; }
            }
            if (!challenge) throw new Error('402 received but no PAYMENT-REQUIRED header and no JSON body could be parsed.');

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
            statusDiv.innerText = '2/4 Connecting wallet...';
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
            statusDiv.innerText = '3/4 Confirming USDC authorization in wallet...';
            const now = Math.floor(Date.now() / 1000);

            const authorization = {
              from: userAddress,
              to: chosen.payTo,
              value: amount,
              validAfter: String(now - 300),        // backdated for clock skew
              validBefore: String(now + timeout),
              nonce: randomNonce()
            };

            const typedData = {
              domain: {
                name: tokenName,
                version: tokenVersion,
                chainId: chainId,
                verifyingContract: asset
              },
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

            // --- Step 4: retry with PAYMENT-SIGNATURE ------------------------
            statusDiv.innerText = '4/4 Verifying and settling with facilitator...';

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

            statusDiv.className = 'success';
            statusDiv.innerText = 'Payment settled!\\n' + rawBody +
              (settlement ? '\\n\\nTx: ' + (settlement.transaction || JSON.stringify(settlement)) : '');
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
// 4. Protected route
// ---------------------------------------------------------------------------
app.get('/api/v1/generate-image', (req, res) => {
  res.json({
    success: true,
    message: 'Payment verified!',
    prompt: req.query.prompt || 'Default prompt'
  });
});

app.get('/healthz', (req, res) => res.json({ ok: true, protocol: 'x402 v2' }));

// Surface middleware errors rather than letting Express swallow them
app.use((err, req, res, next) => {
  console.error('[x402] middleware error:', err);
  res.status(err.status || 500).json({ error: err.message || String(err) });
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server running on port ${PORT} (x402 V2)`));