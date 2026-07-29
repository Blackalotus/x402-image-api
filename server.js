import express from 'express';
import { paymentMiddleware, x402ResourceServer } from '@x402/express';
import { HTTPFacilitatorClient } from '@x402/core/server';
import { ExactEvmScheme } from '@x402/evm/exact/server';

const app = express();
app.set('trust proxy', true);
app.use(express.json());

const WALLET_ADDRESS = '0x3268C9434D8603957420f04510CA0ff6097A5C64';

// 1. Human UI Homepage Route with EIP-712 Typed Signature
app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>AI Image Studio | x402 Micropayments</title>
      <script src="https://cdnjs.cloudflare.com/ajax/libs/ethers/5.7.2/ethers.umd.min.js"></script>
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0f172a; color: #fff; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; padding: 1rem; }
        .card { background: #1e293b; padding: 2rem; border-radius: 12px; max-width: 480px; width: 100%; border: 1px solid #334155; }
        h1 { font-size: 1.5rem; margin-bottom: 0.5rem; }
        p { color: #94a3b8; font-size: 0.9rem; margin-bottom: 1.5rem; }
        .badge { background: #2563eb; color: #fff; padding: 4px 10px; border-radius: 999px; font-size: 0.75rem; font-weight: bold; }
        input { width: 100%; padding: 12px; border-radius: 8px; border: 1px solid #475569; background: #0f172a; color: #fff; margin-bottom: 1rem; box-sizing: border-box; }
        button { width: 100%; padding: 12px; border-radius: 8px; border: none; background: #2563eb; color: #fff; font-weight: bold; cursor: pointer; transition: 0.2s; }
        button:hover { background: #1d4ed8; }
        #status { margin-top: 1rem; font-size: 0.85rem; color: #38bdf8; word-break: break-all; }
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
        async function generate() {
          const promptInput = document.getElementById('prompt').value.trim();
          const statusDiv = document.getElementById('status');
          const btn = document.getElementById('btn');

          if (!promptInput) {
            statusDiv.className = "error";
            statusDiv.innerText = "Please enter a prompt first.";
            return;
          }

          if (!window.ethereum) {
            statusDiv.className = "error";
            statusDiv.innerText = "Please open inside Phantom, Coinbase Wallet, or Rainbow mobile dApp browser.";
            return;
          }

          const endpoint = '/api/v1/generate-image?prompt=' + encodeURIComponent(promptInput);
          statusDiv.className = "";
          statusDiv.innerText = "1/2 Connecting wallet...";
          btn.disabled = true;

          try {
            const provider = new ethers.providers.Web3Provider(window.ethereum);
            await provider.send("eth_requestAccounts", []);
            const signer = provider.getSigner();
            const fromAddress = await signer.getAddress();

            statusDiv.innerText = "2/2 Sign $0.05 Base USDC Authorization in wallet...";

            // Base Mainnet USDC Contract & EIP-712 Domain
            const usdcAddress = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
            const domain = {
              name: 'USD Coin',
              version: '2',
              chainId: 8453, // Base Mainnet
              verifyingContract: usdcAddress
            };

            const types = {
              TransferWithAuthorization: [
                { name: 'from', type: 'address' },
                { name: 'to', type: 'address' },
                { name: 'value', type: 'uint256' },
                { name: 'validAfter', type: 'uint256' },
                { name: 'validBefore', type: 'uint256' },
                { name: 'nonce', type: 'bytes32' }
              ]
            };

            const now = Math.floor(Date.now() / 1000);
            const value = "50000"; // $0.05 USDC (6 decimals)
            const nonce = ethers.utils.hexlify(ethers.utils.randomBytes(32));

            const message = {
              from: fromAddress,
              to: "${WALLET_ADDRESS}",
              value: value,
              validAfter: 0,
              validBefore: now + 3600,
              nonce: nonce
            };

            const signature = await signer._signTypedData(domain, types, message);

            const paymentHeaderPayload = btoa(JSON.stringify({
              scheme: 'exact',
              network: 'eip155:8453',
              payload: {
                signature: signature,
                authorization: message
              }
            }));

            const response = await fetch(endpoint, {
              headers: {
                'X-PAYMENT': paymentHeaderPayload
              }
            });

            if (!response.ok) {
              throw new Error("HTTP " + response.status + ": Verification Failed");
            }

            const data = await response.json();
            statusDiv.className = "success";
            statusDiv.innerText = "Payment Verified! " + JSON.stringify(data);
          } catch (err) {
            statusDiv.className = "error";
            statusDiv.innerText = "Error: " + (err.message || err);
          } finally {
            btn.disabled = false;
          }
        }
      </script>
    </body>
    </html>
  `);
});

// 2. Initialize Facilitator & x402 Resource Server
const facilitatorClient = new HTTPFacilitatorClient({
  url: 'https://facilitator.payai.network',
});

const x402Server = new x402ResourceServer(facilitatorClient);
x402Server.register('eip155:8453', new ExactEvmScheme());

// 3. Configure Micropayment Protection
const routes = {
  'GET /api/v1/generate-image': {
    accepts: [
      {
        scheme: 'exact',
        price: '$0.05',
        network: 'eip155:8453',
        payTo: WALLET_ADDRESS,
      }
    ],
    resource: 'https://x402-image-api.onrender.com/api/v1/generate-image'
  }
};

app.use(paymentMiddleware(routes, x402Server));

// 4. Protected Route
app.get('/api/v1/generate-image', (req, res) => {
  res.json({
    success: true,
    message: "Payment verified!",
    prompt: req.query.prompt || "Default prompt"
  });
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
