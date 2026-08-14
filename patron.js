import { PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';

// Tiers are a monthly recurring pledge, not a merit score. Naming and copy
// matter here as much as the code — this reflects support, not verified
// trustworthiness. Do not rename these to imply "safety" or "verified."
export const PATRON_TIERS = [
  { key: 'supporter', label: 'Lotus Supporter', priceUsd: 5,  path: '/api/v1/patron/pledge/supporter' },
  { key: 'advocate',  label: 'Lotus Advocate',  priceUsd: 15, path: '/api/v1/patron/pledge/advocate' },
  { key: 'champion',  label: 'Lotus Champion',  priceUsd: 50, path: '/api/v1/patron/pledge/champion' }
];

const PLEDGE_DURATION_MS = 30 * 24 * 60 * 60 * 1000; // 1 month

export function createPatronModule({ r2, bucket }) {
  async function loadRecord(prefix, key, fallback) {
    if (!r2) return fallback;
    try {
      const result = await r2.send(new GetObjectCommand({ Bucket: bucket, Key: `${prefix}/${key}.json` }));
      const text = Buffer.from(await result.Body.transformToByteArray()).toString('utf8');
      return JSON.parse(text);
    } catch (err) {
      const notFound = err.name === 'NoSuchKey' || (err.$metadata && err.$metadata.httpStatusCode === 404);
      if (!notFound) console.error(`[patron] read failed (${prefix}/${key}):`, err.message);
      return fallback;
    }
  }

  async function storeRecord(prefix, key, record) {
    if (!r2) return;
    try {
      await r2.send(new PutObjectCommand({
        Bucket: bucket, Key: `${prefix}/${key}.json`,
        Body: Buffer.from(JSON.stringify(record)), ContentType: 'application/json'
      }));
    } catch (err) {
      console.error(`[patron] write failed (${prefix}/${key}):`, err.message);
    }
  }

  const normalize = addr => String(addr || '').toLowerCase();

  async function recordPledge(walletAddress, tierKey) {
    const tier = PATRON_TIERS.find(t => t.key === tierKey);
    if (!tier) throw new Error('Unknown tier');
    const wallet = normalize(walletAddress);
    if (!/^0x[a-f0-9]{40}$/.test(wallet)) throw new Error('Malformed wallet address');

    const now = new Date();
    const expiresAt = new Date(now.getTime() + PLEDGE_DURATION_MS);
    const existing = await loadRecord('patrons', wallet, null);

    const record = {
      wallet, tier: tier.key, tierLabel: tier.label, pledgedUsd: tier.priceUsd,
      pledgedAt: now.toISOString(), expiresAt: expiresAt.toISOString(),
      history: [
        ...(existing?.history || []),
        { tier: tier.key, amountUsd: tier.priceUsd, pledgedAt: now.toISOString() }
      ].slice(-24)
    };

    await storeRecord('patrons', wallet, record);
    return record;
  }

  async function getPatronStatus(walletAddress) {
    const wallet = normalize(walletAddress);
    const record = await loadRecord('patrons', wallet, null);
    if (!record) return { wallet, active: false, tier: null };
    const active = new Date(record.expiresAt) > new Date();
    return {
      wallet, active, tier: active ? record.tier : null, tierLabel: active ? record.tierLabel : null,
      pledgedAt: record.pledgedAt, expiresAt: record.expiresAt,
      note: active
        ? 'Reflects a recurring monthly pledge, not a verified behavior score.'
        : 'No active pledge. Past pledges do not carry over automatically.'
    };
  }

  // Called from server.js's existing payer-extraction middleware on every
  // paid API call — so this is built from real usage, not self-report.
  async function logUsage(walletAddress, route) {
    const wallet = normalize(walletAddress);
    if (!/^0x[a-f0-9]{40}$/.test(wallet)) return;
    const record = await loadRecord('walletUsage', wallet, {
      wallet, firstSeenAt: new Date().toISOString(), totalCalls: 0, byEndpoint: {}
    });
    record.totalCalls += 1;
    record.byEndpoint[route] = (record.byEndpoint[route] || 0) + 1;
    record.lastSeenAt = new Date().toISOString();
    await storeRecord('walletUsage', wallet, record);
  }

  async function getTrustScore(walletAddress) {
    const wallet = normalize(walletAddress);
    const record = await loadRecord('walletUsage', wallet, null);
    if (!record) {
      return { wallet, totalCalls: 0, tenureDays: 0, distinctEndpoints: 0, score: 0,
        note: 'No recorded usage yet. Derived purely from observed API activity.' };
    }
    const tenureDays = Math.floor((Date.now() - new Date(record.firstSeenAt).getTime()) / 86400000);
    const distinctEndpoints = Object.keys(record.byEndpoint).length;
    // Simple, transparent v1 — volume/tenure/variety, each capped. This is a
    // usage summary, not a fraud-resistant score. Say so, don't oversell it.
    const score = Math.min(40, record.totalCalls) + Math.min(30, tenureDays) + Math.min(30, distinctEndpoints * 6);
    return {
      wallet, totalCalls: record.totalCalls, tenureDays, distinctEndpoints,
      firstSeenAt: record.firstSeenAt, lastSeenAt: record.lastSeenAt, score,
      note: 'Derived from observed API usage only — not a moral or safety judgment.'
    };
  }

  function pledgeHandler(tierKey) {
    return async (req, res) => {
      try {
        const walletAddress = (req.body && req.body.walletAddress) || req.walletFromPayment;
        if (!walletAddress) return res.status(400).json({ error: 'Missing walletAddress' });
        res.json({ success: true, ...(await recordPledge(walletAddress, tierKey)) });
      } catch (err) {
        res.status(502).json({ error: 'Payment settled but the pledge could not be recorded: ' + err.message });
      }
    };
  }

  const statusHandler = async (req, res) => {
    try { res.json({ success: true, ...(await getPatronStatus(req.params.walletAddress)) }); }
    catch (err) { res.status(500).json({ error: err.message }); }
  };

  const trustHandler = async (req, res) => {
    try { res.json({ success: true, ...(await getTrustScore(req.params.walletAddress)) }); }
    catch (err) { res.status(500).json({ error: err.message }); }
  };

  return { PATRON_TIERS, recordPledge, getPatronStatus, logUsage, getTrustScore,
    pledgeHandler, statusHandler, trustHandler };
}