'use strict';

const express = require('express');
const { CLAIM_PATH, verifyClaim } = require('./miniAppBridgeAuth');
const { readMiniAppSnapshot } = require('./miniAppReadModel');

function isLoopback(address) {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

function createMiniAppBridgeRouter({
  secret = process.env.ELI_MEMORY_INTERNAL_SECRET,
  now = () => Math.floor(Date.now() / 1000),
  readSnapshot = readMiniAppSnapshot,
} = {}) {
  const router = express.Router();
  const usedNonces = new Map();

  router.post(CLAIM_PATH, async (req, res) => {
    if (!isLoopback(req.socket.remoteAddress)) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    const auth = req.get('authorization') || '';
    const claims = auth.startsWith('Bearer ')
      ? verifyClaim(auth.slice(7), secret, now())
      : null;
    if (!claims) {
      res.status(401).json({ error: 'internal_auth_required' });
      return;
    }
    for (const [nonce, expiry] of usedNonces) {
      if (expiry <= now()) usedNonces.delete(nonce);
    }
    if (usedNonces.has(claims.nonce) || usedNonces.size >= 10_000) {
      res.status(401).json({ error: 'internal_claim_replayed' });
      return;
    }
    usedNonces.set(claims.nonce, (now() + 31));

    try {
      const snapshot = await readSnapshot(claims.userId);
      res.setHeader('Cache-Control', 'no-store');
      res.json({ ok: true, snapshot });
    } catch {
      res.status(503).json({ error: 'legacy_store_unavailable' });
    }
  });

  return router;
}

module.exports = { createMiniAppBridgeRouter };
