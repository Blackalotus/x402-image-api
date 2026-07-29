import express from 'express';
import { paymentMiddleware } from 'x402-express';

const app = express();
app.use(express.json());

// Receiving wallet address
const WALLET_ADDRESS = '0x3268C9434D8603957420f04510CA0ff6097A5C64';

// Apply x402 payment requirements middleware
app.use(
  paymentMiddleware(WALLET_ADDRESS, {
    'GET /api/v1/generate-image': {
      price: '$0.05',
      network: 'base',
      resource: 'resource: 'https://x402-image-api.onrender.com/api/v1/generate-image'
    }
  })
);

// Protected image API route
app.get('/api/v1/generate-image', (req, res) => {
  res.json({
    success: true,
    message: 'Payment verified! Access granted.',
    imageUrl: 'https://example.com/generated-image.png'
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`x402 backend running on http://localhost:${PORT}`);
});
