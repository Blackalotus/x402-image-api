import express from 'express';
import { paymentMiddleware, x402ResourceServer } from '@x402/express';

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
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0f172a; color: #f8fafc; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; }
        .card { background: #1e293b; padding: 2rem; border-radius: 12px; max-width: 480px; width: 100%; box-shadow: 0 10px 25px rgba(0,0,0,0.5); border: 1px solid #334155; text-align: center; }
        h1 { font-size: 1.5rem; margin-bottom: 0.5rem; }
        p { color: #94a3b8; font-size: 0.9rem; margin-bottom: 1.5rem; }
        .badge { background: #2563eb; color: #fff; padding: 4px 10px; border-radius: 20px; font-size: 0.8rem; font-weight: bold; display: inline-block; margin-bottom: 1rem; }
        input { width: 100%; padding: 12px; border-radius: 8px; border: 1px solid #475569; background: #0f172a; color: #fff; box-sizing: border-box; margin-bottom: 1rem; }
        button { width: 100%; padding: 12px; background: #0052ff; color: white; border: none; border-radius: 8px; font-weight: bold; cursor: pointer; font-size: 1rem; transition: 0.2s; }
        button:hover { background: #0045d8; }
        .footer { margin-top: 1.5rem; font-size: 0.75rem; color: #64748b; }
      </style>
    </head>
    <body>
      <div class="card">
        <div class="badge">x402 Protocol Powered</div>
        <h1>AI Image Generator</h1>
        <p>Generate high-resolution AI art on-demand. Pay per request with Base USDC.</p>
        <input type="text" id="prompt" placeholder="Enter image prompt (e.g., Cyberpunk city at night)" />
        <button onclick="generate()">Generate Image ($0.05 Base USDC)</button>
        <div class="footer">API Endpoint for AI Agents: <code>GET /api/v1/generate-image</code></div>
      </div>
      <script>
        function generate() {
          const prompt = encodeURIComponent(document.getElementById('prompt').value || 'Cyberpunk city');
          window.location.href = '/api/v1/generate-image?prompt=' + prompt;
        }
      </script>
    </body>
    </html>
  `);
});

// 2. x402 Micropayment Protection
const x402Server = new x402ResourceServer({
  payTo: WALLET_ADDRESS,
  routes: {
    'GET /api/v1/generate-image': {
      price: '$0.05',
      network: 'base',
      resource: 'https://x402-image-api.onrender.com/api/v1/generate-image'
    }
  }
});

app.use(paymentMiddleware(x402Server));


// 3. Protected Route
app.get('/api/v1/generate-image', (req, res) => {
  res.json({
    success: true,
    message: 'Payment verified! Access granted.',
    imageUrl: 'https://example.com/generated-image.png'
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
