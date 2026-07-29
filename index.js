require('dotenv').config();
const express = require('express');
const Replicate = require('replicate');
const { paymentMiddleware } = require('x402-express');

const app = express();
app.use(express.json());

const replicate = new Replicate({
  auth: process.env.REPLICATE_API_TOKEN,
});

// Configure x402 payment middleware with route definitions
const paywall = paymentMiddleware(process.env.PAY_TO_ADDRESS, {
  "POST /api/v1/generate-thumbnail": {
    price: "$0.05",
    network: "base"
  }
});

app.use(paywall);

app.post('/api/v1/generate-thumbnail', async (req, res) => {
  try {
    const { prompt } = req.body;
    const output = await replicate.run(
      "black-forest-labs/flux-schnell",
      { input: { prompt } }
    );
    return res.status(200).json({
      success: true,
      image_url: output[0],
      price_settled: "$0.05 USDC"
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Image generation failed." });
  }
});

app.listen(process.env.PORT || 3000, () => {
  console.log(`x402 Image API running live on port ${process.env.PORT || 3000}`);
});

