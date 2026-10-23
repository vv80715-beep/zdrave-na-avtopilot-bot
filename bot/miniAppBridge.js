'use strict';

const express = require('express');
const {
  CLAIM_PATH, TEXT_TURN_PATH, MUTATION_PATH, VOICE_TURN_PATH, verifyClaim,
} = require('./miniAppBridgeAuth');
const { readMiniAppSnapshot } = require('./miniAppReadModel');

function isLoopback(address) {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

function createMiniAppBridgeRouter({
  secret = process.env.ELI_MEMORY_INTERNAL_SECRET,
  now = () => Math.floor(Date.now() / 1000),
  readSnapshot = readMiniAppSnapshot,
  processTextTurn,
  processVoiceTurn,
  processMutation,
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
      } else if (error?.code === 'profile_not_found' || error?.code === 'record_not_found') {
        res.status(404).json({ error: error.code });
      } else if (error?.code === 'invalid_request') {
        res.status(400).json({ error: 'invalid_request' });
      } else if (error?.code === 'health_event_not_recognized') {
        res.status(422).json({ error: error.code });
      } else {
        res.status(503).json({ error: expectedPath === CLAIM_PATH
          ? 'legacy_store_unavailable'
          : expectedPath === MUTATION_PATH ? 'mutation_unavailable'
            : expectedPath === VOICE_TURN_PATH ? 'voice_turn_unavailable' : 'text_turn_unavailable' });
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
          Object.keys(body).some((key) => !['message', 'mode', 'turnId'].includes(key)) ||
          typeof body.message !== 'string' || !body.message.trim() || body.message.length > 1200 ||
          !['text', 'voice', 'avatar'].includes(body.mode) ||
          typeof body.turnId !== 'string') {
        throw new Error('mini_app_text_request_invalid');
      }
      if (typeof processTextTurn !== 'function') {
        throw new Error('mini_app_text_engine_unavailable');
      }
      return processTextTurn({
        userId,
        message: body.message.trim(),
        mode: body.mode,
        turnId: body.turnId,
      });
    });
  });

  router.post(VOICE_TURN_PATH, express.raw({
    type: 'application/octet-stream',
    limit: '4mb',
  }), async (req, res) => {
    await authorizeAndRun(req, res, VOICE_TURN_PATH, async (userId, body) => {
      const mode = req.get('x-eli-mode');
      const turnId = req.get('x-eli-turn-id');
      const promptEncoded = req.get('x-eli-prompt') || '';
      let prompt = '';
      try {
        prompt = Buffer.from(promptEncoded, 'base64url').toString('utf8');
      } catch {
        throw Object.assign(new Error('invalid_request'), { code: 'invalid_request' });
      }
      if (!Buffer.isBuffer(body) || !['text', 'voice', 'avatar'].includes(mode) ||
          typeof turnId !== 'string' || prompt.length > 1200 ||
          typeof processVoiceTurn !== 'function') {
        throw Object.assign(new Error('invalid_request'), { code: 'invalid_request' });
      }
      return processVoiceTurn({ userId, audio: body, mode, turnId, prompt });
    });
  });

  router.post(MUTATION_PATH, async (req, res) => {
    await authorizeAndRun(req, res, MUTATION_PATH, async (userId, body) => {
      if (!body || typeof body !== 'object' || Array.isArray(body) ||
          Object.keys(body).some((key) => !['action', 'payload'].includes(key)) ||
          typeof body.action !== 'string' || !body.payload ||
          typeof body.payload !== 'object' || Array.isArray(body.payload)) {
        const error = new Error('invalid_request');
        error.code = 'invalid_request';
        throw error;
      }
      if (typeof processMutation !== 'function') throw new Error('mini_app_mutation_unavailable');
      return processMutation({ userId, action: body.action, payload: body.payload });
    });
  });

  return router;
}

module.exports = { createMiniAppBridgeRouter };
