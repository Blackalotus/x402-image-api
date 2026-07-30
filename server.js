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
//    The client no longer invents the payment terms. It first hits the
//    protected endpoint with no X-PAYMENT header, reads the 402 challenge,
//    and signs EXACTLY what the server asked for.
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
        <h1>AI Image Generator <span class="badge">x402 Active</span></h1>
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
            // --- Step 1: ask the server what it wants (unpaid request) --------
            statusDiv.innerText = '1/4 Requesting payment terms...';
            const probe = await fetch(endpoint);

            if (probe.status !== 402) {
              // Either it's already unlocked, or something is misconfigured.
              const body = await probe.text();
              if (probe.ok) {
                statusDiv.className = 'success';
                statusDiv.innerText = 'Delivered without payment (middleware not gating this route): ' + body;
                return;
              }
              throw new Error('Expected HTTP 402 challenge, got ' + probe.status + ': ' + body);
            }

            const challenge = await probe.json();
            const accepts = challenge.accepts || [];
            const req402 = accepts.find(a => a.scheme === 'exact' && String(a.network).includes('8453'));
            if (!req402) throw new Error('Server offered no exact/Base payment option: ' + JSON.stringify(accepts));

            const chainId = parseInt(String(req402.network).split(':').pop(), 10);
            const amount = req402.maxAmountRequired;          // atomic units, e.g. "50000"
            const asset = req402.asset;                       // USDC contract on Base
            const tokenName = (req402.extra && req402.extra.name) || 'USD Coin';
            const tokenVersion = (req402.extra && req402.extra.version) || '2';
            const timeout = req402.maxTimeoutSeconds || 600;

            // --- Step 2: connect wallet, make sure it's on Base --------------
            statusDiv.innerText = '2/4 Connecting wallet...';
            const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
            const userAddress = accounts[0];

            const wantHex = '0x' + chainId.toString(16);
            const currentChain = await window.ethereum.request({ method: 'eth_chainId' });
            if (currentChain !== wantHex) {
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
                  throw new Error('Wallet refused to switch to Base (chain ' + chainId + '): ' + (switchErr.message || switchErr.code));
                }
              }
              const after = await window.ethereum.request({ method: 'eth_chainId' });
              if (after !== wantHex) throw new Error('Wallet is on chain ' + after + ', needs ' + wantHex + ' (Base).');
            }

            // --- Step 3: sign the EIP-3009 authorization ---------------------
            statusDiv.innerText = '3/4 Confirming USDC permit in wallet...';
            const now = Math.floor(Date.now() / 1000);

            const authorization = {
              from: userAddress,
              to: req402.payTo,
              value: String(amount),
              validAfter: String(now - 300),          // backdated for clock skew
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

            // --- Step 4: retry with the payment header ----------------------
            statusDiv.innerText = '4/4 Verifying micropayment with facilitator...';

            const paymentPayload = {
              x402Version: challenge.x402Version ?? 2,
              scheme: req402.scheme,
              network: req402.network,
              payload: { signature, authorization }
            };

            const header = btoa(JSON.stringify(paymentPayload));
            const paid = await fetch(endpoint, { headers: { 'X-PAYMENT': header } });
            const rawBody = await paid.text();

            if (!paid.ok) {
              let detail = rawBody;
              try {
                const parsed = JSON.parse(rawBody);
                detail = parsed.error || parsed.message || parsed.errorReason || rawBody;
              } catch (_) {}
              throw new Error('HTTP ' + paid.status + ' — ' + detail);
            }

            statusDiv.className = 'success';
            statusDiv.innerText = 'Payment verified!\\n' + rawBody;
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
// 2. Facilitator + resource server
// ---------------------------------------------------------------------------
const facilitatorClient = new HTTPFacilitatorClient({
  url: process.env.FACILITATOR_URL || 'https://facilitator.payai.network'
});

const x402Server = new x402ResourceServer(facilitatorClient);
x402Server.register('eip155:8453', new ExactEvmScheme());

// ---------------------------------------------------------------------------
// 3. Route protection. Log the inbound header so failures are debuggable
//    in the Render logs, then hand off to the middleware.
// ---------------------------------------------------------------------------
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
    resource: `${BASE_URL}/api/v1/generate-image`
  }
};

app.use('/api', (req, res, next) => {
  const hdr = req.headers['x-payment'];
  if (!hdr) {
    console.log(`[x402] ${req.method} ${req.originalUrl} — no X-PAYMENT, issuing challenge`);
  } else {
    try {
      console.log(`[x402] inbound payment:`, JSON.stringify(JSON.parse(Buffer.from(hdr, 'base64').toString())));
    } catch (e) {
      console.log('[x402] X-PAYMENT header is not valid base64 JSON');
    }
  }
  next();
});

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

app.get('/healthz', (req, res) => res.json({ ok: true }));

// Surface middleware errors instead of letting Express swallow them
app.use((err, req, res, next) => {
  console.error('[x402] middleware error:', err);
  res.status(err.status || 500).json({ error: err.message || String(err) });
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});