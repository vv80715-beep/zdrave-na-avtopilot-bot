'use strict';

const express = require('express');
const { CLAIM_PATH, TEXT_TURN_PATH, verifyClaim } = require('./miniAppBridgeAuth');
const { readMiniAppSnapshot } = require('./miniAppReadModel');

function isLoopback(address) {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

function createMiniAppBridgeRouter({
  secret = process.env.ELI_MEMORY_INTERNAL_SECRET,
  now = () => Math.floor(Date.now() / 1000),
  readSnapshot = readMiniAppSnapshot,
  processTextTurn,
} = {}) {
  const router = express.Router();
  const usedNonces = new Map();

  async function authorizeAndRun(req, res, expectedPath, run) {
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
    if (claims.path !== expectedPath) {
      res.status(401).json({ error: 'internal_claim_path_mismatch' });
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
      res.setHeader('Cache-Control', 'no-store');
      const result = await run(claims.userId, req.body);
      res.json({ ok: true, ...result });
    } catch (error) {
      if (error?.code === 'owner_only') {
        res.status(403).json({ error: 'owner_only' });
      } else if (error?.code === 'invalid_request') {
        res.status(400).json({ error: 'invalid_request' });
      } else {
        res.status(503).json({ error: expectedPath === CLAIM_PATH
          ? 'legacy_store_unavailable'
          : 'text_turn_unavailable' });
      }
    }
  }

  router.post(CLAIM_PATH, async (req, res) => {
    await authorizeAndRun(req, res, CLAIM_PATH, async (userId) => ({
      snapshot: await readSnapshot(userId),
    }));
  });

  router.post(TEXT_TURN_PATH, async (req, res) => {
    await authorizeAndRun(req, res, TEXT_TURN_PATH, async (userId, body) => {
      if (!body || typeof body !== 'object' || Array.isArray(body) ||
          Object.keys(body).length !== 1 || typeof body.message !== 'string' ||
          !body.message.trim() || body.message.length > 1200) {
        throw new Error('mini_app_text_request_invalid');
      }
      if (typeof processTextTurn !== 'function') {
        throw new Error('mini_app_text_engine_unavailable');
      }
      return processTextTurn({ userId, message: body.message.trim() });
    });
  });

  return router;
}

module.exports = { createMiniAppBridgeRouter };
