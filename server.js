import express from 'express';
import { paymentMiddleware, x402ResourceServer } from '@x402/express';
import { HTTPFacilitatorClient } from '@x402/core/server';
import { ExactEvmScheme } from '@x402/evm/exact/server';

const app = express();
app.set('trust proxy', true);
app.use(express.json());

const WALLET_ADDRESS = '0x3268C9434D8603957420f04510CA0ff6097A5C64';

// 1. Human UI Homepage Route
app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>AI Image Studio | x402 Micropayments</title>
      <!-- Inject x402 Paywall client SDK -->
      <script src="https://unpkg.com/@x402/paywall@latest/dist/paywall.min.js"></script>
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0f172a; color: #fff; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; padding: 1rem; }
        .card { background: #1e293b; padding: 2rem; border-radius: 12px; max-width: 480px; width: 100%; border: 1px solid #334155; }
        h1 { font-size: 1.5rem; margin-bottom: 0.5rem; }
        p { color: #94a3b8; font-size: 0.9rem; margin-bottom: 1.5rem; }
        .badge { background: #2563eb; color: #fff; padding: 4px 10px; border-radius: 999px; font-size: 0.75rem; font-weight: bold; }
        input { width: 100%; padding: 12px; border-radius: 8px; border: 1px solid #475569; background: #0f172a; color: #fff; margin-bottom: 1rem; box-sizing: border-box; }
        button { width: 100%; padding: 12px; border-radius: 8px; border: none; background: #2563eb; color: #fff; font-weight: bold; cursor: pointer; transition: 0.2s; }
        button:hover { background: #1d4ed8; }
      </style>
    </head>
    <body>
      <div class="card">
        <h1>AI Image Generator <span class="badge">x402 Active</span></h1>
        <p>Enter a prompt below. Payment of $0.05 Base USDC will be prompted via your connected wallet.</p>
        <input type="text" id="prompt" placeholder="e.g. Cyberpunk city in neon rain..." value="Cyberpunk city in neon rain">
        <button onclick="generate()">Generate Image ($0.05 Base USDC)</button>
      </div>

      <script>
        async function generate() {
          const prompt = encodeURIComponent(document.getElementById('prompt').value);
          const endpoint = '/api/v1/generate-image?prompt=' + prompt;

          // Trigger x402 paywall client modal for wallet signature/payment
          if (window.x402Paywall) {
            await window.x402Paywall.fetch(endpoint);
          } else {
            window.location.href = endpoint;
          }
        }
      </script>
    </body>
    </html>
  `);
});

// 2. Initialize Active Facilitator & Resource Server
const facilitatorClient = new HTTPFacilitatorClient({
  url: 'https://facilitator.payai.network',
});

const x402Server = new x402ResourceServer(facilitatorClient);
x402Server.register('eip155:8453', new ExactEvmScheme());

// 3. x402 Micropayment Protection Route Config
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
