'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createCipher } = require('../brain/universal/encryption');
const { createFileRepository } = require('../brain/universal/repositories');
const { createSemanticEngine } = require('../brain/universal/semantic');
const { createMemoryService } = require('../brain/universal/service');

const USER_A = '880000000001';
const USER_B = '880000000002';

function answer({ classification = 'ordinary', subject = 'self', topic, evidence, existingId = null, relation = existingId ? 'changed' : 'new', selectedIds = [] } = {}) {
  return { classification, subject, facts: topic ? [{ topic, evidence, existingId, relation }] : [], selectedIds };
}

function fakeOpenAI(responder) {
  const calls = [];
  return {
    calls,
    chat: { completions: { async create(request) {
      calls.push(request);
      const data = JSON.parse(request.messages.at(-1).content);
      const result = await responder({ ...data, facts: data.existingFacts }, request);
      if (result?.choices) return result;
      return { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(result) } }] };
    } } },
  };
}

async function rig(t, responder, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'eli-synthetic-memory-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const key = crypto.randomBytes(32).toString('base64');
  const cipher = createCipher(key);
  const repository = createFileRepository({ directory, cipher });
  const openai = fakeOpenAI(responder);
  const semantic = createSemanticEngine({ openai });
  const diagnostics = [];
  const service = createMemoryService({ repository, semantic, diagnostic: (e) => diagnostics.push(e), ...options });
  return { directory, key, cipher, repository, openai, semantic, service, diagnostics };
}

module.exports = { USER_A, USER_B, answer, fakeOpenAI, rig };
