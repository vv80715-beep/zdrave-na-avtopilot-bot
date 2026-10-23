'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');

function loadWithFakeOpenAI(mockCreate) {
  const openaiPath = require.resolve('../openaiClient');
  const voicePath = require.resolve('../voiceTranscription');
  const previousOpenAI = require.cache[openaiPath];
  const previousVoice = require.cache[voicePath];
  require.cache[openaiPath] = {
    id: openaiPath,
    filename: openaiPath,
    loaded: true,
    exports: { audio: { transcriptions: { create: mockCreate } } },
  };
  delete require.cache[voicePath];
  return {
    transcribe: require('../voiceTranscription').transcribeAudioBuffer,
    restore() {
      if (previousOpenAI) require.cache[openaiPath] = previousOpenAI;
      else delete require.cache[openaiPath];
      if (previousVoice) require.cache[voicePath] = previousVoice;
      else delete require.cache[voicePath];
    },
  };
}

function syntheticWav() {
  return Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE'), Buffer.alloc(36)]);
}

test('buffer transcription uses the configured STT contract and deletes its temporary audio', async () => {
  let path;
  const fake = loadWithFakeOpenAI(async ({ file, model, language }) => {
    path = file.path;
    assert.equal(model, 'gpt-4o-transcribe');
    assert.equal(language, 'bg');
    assert.equal(fs.existsSync(path), true);
    for await (const _chunk of file) { /* consume the synthetic upload stream */ }
    return { text: 'Синтетична транскрипция.' };
  });
  try {
    assert.equal(await fake.transcribe(syntheticWav()), 'Синтетична транскрипция.');
    assert.equal(fs.existsSync(path), false);
  } finally {
    fake.restore();
  }
});

test('buffer transcription cleans up after provider failure without exposing the audio path', async () => {
  let path;
  const fake = loadWithFakeOpenAI(async ({ file }) => {
    path = file.path;
    for await (const _chunk of file) { /* consume the synthetic upload stream */ }
    throw new Error('synthetic provider failure');
  });
  try {
    await assert.rejects(fake.transcribe(syntheticWav()), /synthetic provider failure/);
    assert.equal(fs.existsSync(path), false);
  } finally {
    fake.restore();
  }
});

test('buffer transcription rejects invalid audio before contacting the provider', async () => {
  let calls = 0;
  const fake = loadWithFakeOpenAI(async () => { calls += 1; return { text: '' }; });
  try {
    await assert.rejects(fake.transcribe(Buffer.from('not wav')));
    assert.equal(calls, 0);
  } finally {
    fake.restore();
  }
});
