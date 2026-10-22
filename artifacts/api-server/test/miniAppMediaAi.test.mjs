import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createOpenAiMediaAiProcessor } from "../src/lib/miniAppMediaAi.ts";

async function withMediaFile(bytes, callback) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "eli-media-ai-test-"));
  const filePath = path.join(directory, "media");
  try {
    await writeFile(filePath, bytes);
    await callback(filePath);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("vision adapter uses a server-only gpt-4o-mini image payload and the selected language", async () => {
  const image = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  let requestBody;
  const fetchMock = async (_url, init) => {
    requestBody = JSON.parse(init.body);
    return new Response(JSON.stringify({
      choices: [{ message: { content: "A simple mock response." } }],
    }), { status: 200 });
  };
  await withMediaFile(image, async (filePath) => {
    const processor = createOpenAiMediaAiProcessor("offline-fake-key", fetchMock);
    const result = await processor.analyzeImage({
      path: filePath,
      mimeType: "image/png",
      caption: "What is visible?",
      language: "en",
    });
    assert.deepEqual(result, { reply: "A simple mock response." });
  });
  assert.equal(requestBody.model, "gpt-4o-mini");
  assert.match(requestBody.messages[0].content, /Do not identify people/);
  const content = requestBody.messages[1].content;
  assert.equal(content[0].text.includes("What is visible?"), true);
  assert.equal(content[1].image_url.url, `data:image/png;base64,${image.toString("base64")}`);
});

test("voice adapter uses mocked gpt-4o-transcribe then gpt-4o-mini, with no TTS path", async () => {
  const calls = [];
  const fetchMock = async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith("/audio/transcriptions")) {
      assert.ok(init.body instanceof FormData);
      assert.equal(init.body.get("model"), "gpt-4o-transcribe");
      assert.equal(init.body.get("language"), "bg");
      return new Response(JSON.stringify({ text: "Искам да се разходя." }), { status: 200 });
    }
    const chat = JSON.parse(init.body);
    assert.equal(chat.model, "gpt-4o-mini");
    assert.match(chat.messages[1].content, /Искам да се разходя/);
    return new Response(JSON.stringify({
      choices: [{ message: { content: "Нека започнем с кратка разходка." } }],
    }), { status: 200 });
  };
  const audio = Buffer.from("OggS-mocked-audio");
  await withMediaFile(audio, async (filePath) => {
    const processor = createOpenAiMediaAiProcessor("offline-fake-key", fetchMock);
    const result = await processor.transcribeAndAnswer({
      path: filePath,
      mimeType: "audio/ogg",
      language: "bg",
    });
    assert.deepEqual(result, {
      transcript: "Искам да се разходя.",
      reply: "Нека започнем с кратка разходка.",
    });
  });
  assert.equal(calls.length, 2);
  assert.ok(calls.every(({ init }) => init.signal instanceof AbortSignal));
});
