import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createRequire } from "node:module";
import { mkdtemp, readdir, rm, writeFile, readFile } from "node:fs/promises";
import cors from "cors";
import express from "express";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createOpenAiTextAiAdapter,
  createMiniAppRouter,
  miniAppConfigEnabled,
  mountMiniAppRoutes,
} from "../src/routes/miniApp.ts";

const TOKEN = "offline-fake-telegram-token-never-used";
const SESSION_SECRET = "offline-session-secret-for-tests-only-000000";
const OWNER_ID = "123456789";
const ORIGIN = "https://eli-stage.replit.dev";
const NOW_SECONDS = 1_800_000_000;
const require = createRequire(import.meta.url);

function config(overrides = {}) {
  return {
    NODE_ENV: "development",
    ELI_MINI_APP_STAGE: "staging",
    ELI_MINI_APP_SESSION_ENABLED: "true",
    ELI_MINI_APP_ORIGIN: ORIGIN,
    OWNER_TELEGRAM_ID: OWNER_ID,
    TELEGRAM_BOT_TOKEN: TOKEN,
    SESSION_SECRET,
    ...overrides,
  };
}

function signedInitData({ userId = OWNER_ID, authDate = NOW_SECONDS } = {}) {
  const fields = new URLSearchParams({
    auth_date: String(authDate),
    query_id: `test-${authDate}-${userId}`,
    user: JSON.stringify({ id: userId, first_name: "offline" }),
  });
  const dataCheckString = [...fields.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const secret = createHmac("sha256", "WebAppData").update(TOKEN).digest();
  fields.set("hash", createHmac("sha256", secret).update(dataCheckString).digest("hex"));
  return fields.toString();
}

async function serverHarness({
  env = config(),
  now = () => NOW_SECONDS * 1000,
  media,
  textAi,
  ownerDossierContext,
  ownerDossierFaq,
  ownerDossierPath,
  ownerDossierFixture,
  readProfileSnapshot,
  bridgeSecret,
  bridgeFetch,
} = {}) {
  let generatedDossierRoot;
  let resolvedDossierPath = ownerDossierPath;
  if (
    !resolvedDossierPath &&
    env.NODE_ENV === "development" &&
    env.ELI_MINI_APP_OWNER_DOSSIER_ENABLED === "true"
  ) {
    generatedDossierRoot = await mkdtemp(path.join(os.tmpdir(), "eli-mini-dossier-fixture-"));
    resolvedDossierPath = path.join(generatedDossierRoot, "owner_dossier.json");
    await writeFile(resolvedDossierPath, JSON.stringify({
      schemaVersion: 1,
      facts: ownerDossierFixture || [],
    }), { mode: 0o600 });
  }
  const app = express();
  const mounted = mountMiniAppRoutes(app, env, {
    now,
    media,
    textAi,
    ownerDossierContext,
    ownerDossierFaq,
    ownerDossierPath: resolvedDossierPath,
    readProfileSnapshot,
    bridgeSecret,
    bridgeFetch,
  });
  app.use((_req, res) => res.status(404).json({ error: "not_found" }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}/api/mini-app`;
  return {
    mounted,
    async request(path, body, { origin = ORIGIN, cookie, method = "POST" } = {}) {
      const headers = {};
      if (origin !== null) headers.Origin = origin;
      if (body !== undefined && !(body instanceof FormData)) headers["Content-Type"] = "application/json";
      if (cookie) headers.Cookie = cookie;
      return fetch(`${baseUrl}${path}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body: body instanceof FormData ? body : JSON.stringify(body) }),
      });
    },
    async close() {
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      if (generatedDossierRoot) {
        await rm(generatedDossierRoot, { recursive: true, force: true });
      }
    },
  };
}

function loadSyntheticOwnerDossierModule() {
  const dossierPath = require.resolve("../../../bot/ownerDossier.js");
  const adminGuardPath = require.resolve("../../../bot/adminGuard.js");
  const previousDossier = require.cache[dossierPath];
  const adminGuardModule = require.cache[adminGuardPath];
  assert.ok(adminGuardModule, "owner guard module should already be loaded");
  const previousGuardExports = adminGuardModule.exports;
  delete require.cache[dossierPath];
  adminGuardModule.exports = {
    isOwnerId: (userId) => String(userId) === OWNER_ID,
  };
  try {
    return require(dossierPath);
  } finally {
    adminGuardModule.exports = previousGuardExports;
    if (previousDossier) require.cache[dossierPath] = previousDossier;
    else delete require.cache[dossierPath];
  }
}

async function ownerCookie(h) {
  const response = await h.request("/session", { initData: signedInitData() });
  assert.equal(response.status, 200);
  return response.headers.get("set-cookie").split(";")[0];
}

function legacyCookieFor(userId) {
  const payload = Buffer.from(JSON.stringify({
    sub: userId,
    iat: NOW_SECONDS,
    exp: NOW_SECONDS + 600,
    nonce: `legacy-${userId}`,
  })).toString("base64url");
  const signature = createHmac("sha256", SESSION_SECRET)
    .update(`eli-mini-session-v1.${payload}`)
    .digest("base64url");
  return `eli_mini_session=${payload}.${signature}`;
}

function imageForm(bytes, { mime = "image/jpeg", filename = "photo.jpg" } = {}) {
  const form = new FormData();
  form.set("file", new Blob([bytes], { type: mime }), filename);
  form.set("language", "bg");
  return form;
}

test("staging API is not mounted when the flag, stage, owner, origin, or secrets are missing", async () => {
  assert.equal(miniAppConfigEnabled(config({ ELI_MINI_APP_SESSION_ENABLED: "false" })), false);
  assert.equal(miniAppConfigEnabled(config({
    NODE_ENV: "production",
    ELI_MINI_APP_OWNER_DOSSIER_ENABLED: "true",
  })), false);
  assert.equal(miniAppConfigEnabled(config({ OWNER_TELEGRAM_ID: "" })), false);
  assert.equal(miniAppConfigEnabled(config({ TELEGRAM_BOT_TOKEN: "" })), false);
  assert.equal(miniAppConfigEnabled(config({ SESSION_SECRET: "" })), false);
  assert.equal(miniAppConfigEnabled(config({ ELI_MINI_APP_ORIGIN: "http://eli-stage.replit.dev" })), false);
  assert.equal(miniAppConfigEnabled(config({ ELI_MINI_APP_ORIGIN: "https://localhost" })), false);
  assert.equal(miniAppConfigEnabled(config({
    NODE_ENV: "production",
    ELI_MINI_APP_STAGE: "production",
  })), true);

  const h = await serverHarness({ env: config({ ELI_MINI_APP_SESSION_ENABLED: "false" }) });
  try {
    assert.equal(h.mounted, false);
    assert.equal((await h.request("/session", {})).status, 404);
  } finally {
    await h.close();
  }
});

test("existing API routes retain the pre-existing global CORS behavior", async () => {
  const app = express();
  assert.equal(mountMiniAppRoutes(app, config({ ELI_MINI_APP_SESSION_ENABLED: "false" })), false);
  app.use(cors());
  app.get("/api/healthz", (_req, res) => res.json({ status: "ok" }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  try {
    const address = server.address();
    const response = await fetch(`http://127.0.0.1:${address.port}/api/healthz`, {
      headers: { Origin: "https://existing-client.example" },
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("access-control-allow-origin"), "*");
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

test("owner initData issues a secure session and retired demo routes fail closed", async () => {
  const h = await serverHarness();
  try {
    const sessionResponse = await h.request("/session", { initData: signedInitData() });
    assert.equal(sessionResponse.status, 200);
    assert.equal(sessionResponse.headers.get("access-control-allow-origin"), ORIGIN);
    assert.equal(sessionResponse.headers.get("access-control-allow-credentials"), "true");
    assert.equal(sessionResponse.headers.get("cache-control"), "no-store");
    const setCookie = sessionResponse.headers.get("set-cookie");
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /Secure/);
    assert.match(setCookie, /SameSite=Strict/);
    assert.match(setCookie, /Max-Age=600/);
    const cookie = setCookie.split(";")[0];

    assert.equal((await h.request("/demo-chat", { message: "private health detail" }, { cookie })).status, 404);
    assert.equal((await h.request("/demo-chat/", { message: "private health detail" }, { cookie })).status, 404);
    assert.equal((await h.request("/text-ai", { message: "private health detail" }, { cookie })).status, 404);
    assert.equal((await h.request("/text-ai/", { message: "private health detail" }, { cookie })).status, 404);

    const replay = await h.request("/session", { initData: signedInitData() });
    assert.equal(replay.status, 401);
    const sameSessionRetry = await h.request(
      "/session",
      { initData: signedInitData() },
      { cookie },
    );
    assert.equal(sameSessionRetry.status, 200);
    assert.equal(sameSessionRetry.headers.get("set-cookie"), null);
  } finally {
    await h.close();
  }
});

test("signed initData can renew the same valid session after its five-minute freshness window", async () => {
  let currentTime = NOW_SECONDS * 1000;
  const h = await serverHarness({ now: () => currentTime });
  try {
    const initData = signedInitData();
    const initial = await h.request("/session", { initData });
    assert.equal(initial.status, 200);
    const cookie = initial.headers.get("set-cookie").split(";")[0];
    currentTime += 301_000;
    const repeated = await h.request("/session", { initData }, { cookie });
    assert.equal(repeated.status, 200);
    assert.equal(repeated.headers.get("set-cookie"), null);
    const withoutSession = await h.request("/session", { initData });
    assert.equal(withoutSession.status, 401);
    assert.deepEqual(await withoutSession.json(), { error: "init_data_replayed" });
  } finally {
    await h.close();
  }
});

test("rejects forged, expired, and non-owner initData; stale client cookies cannot read staging data", async () => {
  const h = await serverHarness();
  try {
    assert.equal((await h.request("/session", { initData: "malformed" })).status, 401);
    const forged = new URLSearchParams(signedInitData());
    forged.set("user", JSON.stringify({ id: OWNER_ID, first_name: "forged" }));
    assert.equal((await h.request("/session", { initData: forged.toString() })).status, 401);
    assert.equal((await h.request("/session", {
      initData: signedInitData({ authDate: NOW_SECONDS - 301 }),
    })).status, 401);
    const client = await h.request("/session", {
      initData: signedInitData({ userId: "987654321" }),
    });
    assert.equal(client.status, 403);
    assert.deepEqual(await client.json(), { error: "owner_only" });

    const staleCookie = legacyCookieFor("987654321");
    const profile = await h.request("/profile", {}, { cookie: staleCookie });
    assert.equal(profile.status, 403);
    assert.deepEqual(await profile.json(), { error: "owner_only" });
    const chat = await h.request("/chat", { message: "synthetic client request" }, { cookie: staleCookie });
    assert.equal(chat.status, 403);
    assert.deepEqual(await chat.json(), { error: "owner_only" });
  } finally {
    await h.close();
  }
});

test("requires origin/CSRF checks and rejects demo access without a valid session", async () => {
  const h = await serverHarness();
  try {
    assert.equal((await h.request("/session", { initData: signedInitData() }, { origin: "https://evil.example" })).status, 403);
    assert.equal((await h.request("/session", { initData: signedInitData() }, { origin: null })).status, 403);
    assert.equal((await h.request("/demo-chat", { message: "hello" })).status, 401);
    const preflight = await h.request("/session", undefined, { method: "OPTIONS" });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("access-control-allow-origin"), ORIGIN);
    assert.equal(preflight.headers.get("access-control-allow-credentials"), "true");
    const evilPreflight = await h.request("/session", undefined, { method: "OPTIONS", origin: "https://evil.example" });
    assert.equal(evilPreflight.headers.get("access-control-allow-origin"), null);
  } finally {
    await h.close();
  }
});

test("session expiry is enforced server-side and demo input is never returned or persisted", async () => {
  let now = NOW_SECONDS * 1000;
  const h = await serverHarness({ now: () => now });
  try {
    const response = await h.request("/session", { initData: signedInitData() });
    const cookie = response.headers.get("set-cookie").split(";")[0];
    now += 601_000;
    const demo = await h.request("/demo-chat", { message: "do not retain this" }, { cookie });
    assert.equal(demo.status, 401);
    assert.equal((await demo.text()).includes("do not retain this"), false);
  } finally {
    await h.close();
  }
});

test("media routes return 404 without the separate default-off flag and never call a processor", async () => {
  let providerCalls = 0;
  const h = await serverHarness({
    env: config({
      ELI_MINI_APP_MEDIA_AI_ENABLED: "true",
      OPENAI_API_KEY: "offline-fake-key-never-used",
    }),
    media: { processor: {
      analyzeImage: async () => { providerCalls += 1; return { reply: "never" }; },
      transcribeAndAnswer: async () => { providerCalls += 1; return { transcript: "never", reply: "never" }; },
    } },
  });
  try {
    const response = await h.request("/media/image", imageForm(Buffer.from([0xff, 0xd8, 0xff])));
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: "not_found" });
    assert.equal(providerCalls, 0);
  } finally {
    await h.close();
  }
});

test("media endpoint requires the same owner session and verifies image signature before mock processing", async () => {
  let providerCalls = 0;
  const h = await serverHarness({
    env: config({ ELI_MINI_APP_MEDIA_MOCK_ENABLED: "true" }),
    media: {
      processor: {
        analyzeImage: async () => { providerCalls += 1; return { reply: "mock description" }; },
        transcribeAndAnswer: async () => { providerCalls += 1; return { transcript: "mock", reply: "mock" }; },
      },
    },
  });
  try {
    const unauthenticated = await h.request("/media/image", imageForm(Buffer.from([0xff, 0xd8, 0xff])));
    assert.equal(unauthenticated.status, 401);
    assert.equal(providerCalls, 0);

    const cookie = await ownerCookie(h);
    const spoofed = await h.request("/media/image", imageForm(Buffer.from("not really jpeg")), { cookie });
    assert.equal(spoofed.status, 415);
    assert.equal(providerCalls, 0);

    const valid = await h.request(
      "/media/image",
      imageForm(Buffer.from([0xff, 0xd8, 0xff, 0xd9]), { filename: "../../private.jpg" }),
      { cookie },
    );
    assert.equal(valid.status, 200);
    assert.deepEqual(await valid.json(), { reply: "mock description", mediaType: "image", staged: true, demo: true });
    assert.equal(providerCalls, 1);
  } finally {
    await h.close();
  }
});

test("media upload rejects image size overflow before mock processing", async () => {
  let providerCalls = 0;
  const h = await serverHarness({
    env: config({ ELI_MINI_APP_MEDIA_MOCK_ENABLED: "true" }),
    media: {
      processor: {
        analyzeImage: async () => { providerCalls += 1; return { reply: "never" }; },
        transcribeAndAnswer: async () => { providerCalls += 1; return { transcript: "never", reply: "never" }; },
      },
    },
  });
  try {
    const cookie = await ownerCookie(h);
    const oversized = imageForm(Buffer.concat([
      Buffer.from([0xff, 0xd8, 0xff]),
      Buffer.alloc(8 * 1024 * 1024),
    ]));
    const response = await h.request("/media/image", oversized, { cookie });
    assert.equal(response.status, 413);
    assert.equal(providerCalls, 0);
  } finally {
    await h.close();
  }
});

test("voice upload enforces magic bytes and the 90 second limit; responses stay text-only", async () => {
  let providerCalls = 0;
  const h = await serverHarness({
    env: config({ ELI_MINI_APP_MEDIA_MOCK_ENABLED: "true" }),
    media: {
      processor: {
        analyzeImage: async () => { providerCalls += 1; return { reply: "never" }; },
        transcribeAndAnswer: async () => { providerCalls += 1; return { transcript: "Здравей, Ели.", reply: "Здравей!" }; },
      },
      inspectAudioDuration: async () => 91,
    },
  });
  try {
    const cookie = await ownerCookie(h);
    const form = new FormData();
    form.set("file", new Blob([Buffer.from("OggS-not-a-real-audio-file")], { type: "audio/ogg" }), "ignored.ogg");
    form.set("language", "bg");
    const tooLong = await h.request("/media/voice", form, { cookie });
    assert.equal(tooLong.status, 413);
    assert.deepEqual(await tooLong.json(), { error: "audio_too_long" });
    assert.equal(providerCalls, 0);

    const invalid = new FormData();
    invalid.set("file", new Blob([Buffer.from("not ogg")], { type: "audio/ogg" }), "voice.ogg");
    const spoofed = await h.request("/media/voice", invalid, { cookie });
    assert.equal(spoofed.status, 415);
    assert.equal(providerCalls, 0);
  } finally {
    await h.close();
  }
});

test("valid voice upload returns mocked transcript and text reply, then removes its temporary directory", async () => {
  let processorCalls = 0;
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "eli-mini-api-test-"));
  const h = await serverHarness({
    env: config({ ELI_MINI_APP_MEDIA_MOCK_ENABLED: "true" }),
    media: {
      tempRoot,
      inspectAudioDuration: async () => 12,
      normalizeAudio: async (filePath) => filePath,
      processor: {
        analyzeImage: async () => ({ reply: "unused" }),
        transcribeAndAnswer: async ({ mimeType }) => {
          processorCalls += 1;
          assert.equal(mimeType, "audio/wav");
          return { transcript: "Искам да се разходя.", reply: "Нека започнем с кратка разходка." };
        },
      },
    },
  });
  try {
    const cookie = await ownerCookie(h);
    const form = new FormData();
    form.set("file", new Blob([Buffer.from("OggS-mocked-audio")], { type: "audio/ogg" }), "unsafe/voice.ogg");
    form.set("language", "bg");
    const response = await h.request("/media/voice", form, { cookie });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      transcript: "Искам да се разходя.",
      reply: "Нека започнем с кратка разходка.",
      mediaType: "voice",
      staged: true,
      demo: true,
    });
    assert.equal(processorCalls, 1);
    assert.deepEqual(await readdir(tempRoot), []);

    let currentTime = NOW_SECONDS * 1000;
    const expired = await serverHarness({
      env: config({ ELI_MINI_APP_MEDIA_MOCK_ENABLED: "true" }),
      now: () => currentTime,
      media: { processor: {
        analyzeImage: async () => ({ reply: "never" }),
        transcribeAndAnswer: async () => { processorCalls += 1; return { transcript: "never", reply: "never" }; },
      } },
    });
    try {
      const staleCookie = await ownerCookie(expired);
      currentTime += 601_000;
      const request = await expired.request("/media/voice", form, { cookie: staleCookie });
      assert.equal(request.status, 401);
      assert.equal(processorCalls, 1);
    } finally {
      await expired.close();
    }
  } finally {
    await h.close();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("mock-only media flag returns fixed non-analysis copy even when an OpenAI key is present", async () => {
  const h = await serverHarness({
    env: config({
      ELI_MINI_APP_MEDIA_MOCK_ENABLED: "true",
      OPENAI_API_KEY: "offline-fake-key-never-used",
    }),
  });
  try {
    const cookie = await ownerCookie(h);
    const response = await h.request(
      "/media/image",
      imageForm(Buffer.from([0xff, 0xd8, 0xff, 0xd9])),
      { cookie },
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      reply: "Фиксиран staging mock: снимката е приета, но не е анализирана.",
      mediaType: "image",
      staged: true,
      demo: true,
    });
  } finally {
    await h.close();
  }
});

test("retired demo chat always returns 404 without calling a provider", async () => {
  let providerCalls = 0;
  const h = await serverHarness({
    textAi: async () => { providerCalls += 1; return "must not run"; },
  });
  try {
    const cookie = await ownerCookie(h);
    const response = await h.request("/demo-chat", { message: "synthetic" }, { cookie });
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: "not_found" });
    assert.equal(providerCalls, 0);
  } finally {
    await h.close();
  }
});

test("retired text AI routes always return 404 and never call a provider", async () => {
  let providerCalls = 0;
  const disabled = await serverHarness({
    env: config(),
    textAi: async () => { providerCalls += 1; return "never"; },
  });
  try {
    assert.equal((await disabled.request("/text-ai", { message: "synthetic" })).status, 401);
    assert.equal((await disabled.request("/text-ai/status", {})).status, 401);
    const cookie = await ownerCookie(disabled);
    assert.equal((await disabled.request("/text-ai", { message: "synthetic" }, { cookie })).status, 404);
    const status = await disabled.request("/text-ai/status", {}, { cookie });
    assert.equal(status.status, 404);
    assert.deepEqual(await status.json(), { error: "not_found" });
    assert.equal((await disabled.request("/text-ai/status", undefined, { cookie, method: "GET" })).status, 404);
    assert.equal((await disabled.request("/text-ai/status", {}, { cookie, origin: null })).status, 403);
    assert.equal(providerCalls, 0);
  } finally {
    await disabled.close();
  }

  const missingKey = await serverHarness({
    env: config({ ELI_MINI_APP_TEXT_AI_ENABLED: "true" }),
    textAi: async () => { providerCalls += 1; return "never"; },
  });
  try {
    const cookie = await ownerCookie(missingKey);
    assert.equal((await missingKey.request("/text-ai", { message: "synthetic" }, { cookie })).status, 404);
    assert.equal((await missingKey.request("/text-ai/status", {}, { cookie })).status, 404);
    assert.equal(providerCalls, 0);
  } finally {
    await missingKey.close();
  }
});

test("retired text AI route stays 404 even with its old feature flag enabled", async () => {
  let providerCalls = 0;
  const h = await serverHarness({
    env: config({
      ELI_MINI_APP_TEXT_AI_ENABLED: "true",
      OPENAI_API_KEY: `sk-${"x".repeat(24)}`,
    }),
    textAi: async ({ message, language, ownerDossierContext }) => {
      providerCalls += 1;
      assert.equal(message, "synthetic test");
      assert.equal(language, "en");
      assert.equal(ownerDossierContext, undefined);
      return "Synthetic AI reply.";
    },
  });
  try {
    const cookie = await ownerCookie(h);
    const status = await h.request("/text-ai/status", {}, { cookie });
    assert.equal(status.status, 404);
    assert.deepEqual(await status.json(), { error: "not_found" });
    assert.equal((await h.request("/text-ai", { message: "synthetic test" }, {
      cookie,
      origin: "https://untrusted.example",
    })).status, 403);
    assert.equal((await h.request("/text-ai", { message: "x".repeat(1201) }, { cookie })).status, 404);
    assert.equal((await h.request("/text-ai", { message: "synthetic test", language: "fr" }, { cookie })).status, 404);
    for (let index = 0; index < 5; index += 1) {
      const response = await h.request("/text-ai", { message: "synthetic test", language: "en" }, { cookie });
      assert.equal(response.status, 404);
      assert.deepEqual(await response.json(), { error: "not_found" });
    }
    const limited = await h.request("/text-ai", { message: "synthetic test" }, { cookie });
    assert.equal(limited.status, 404);
    assert.equal(providerCalls, 0);
  } finally {
    await h.close();
  }
});

test("retired owner dossier text route stays 404 without reading dossier or calling a provider", async () => {
  const syntheticContext = "SYNTHETIC_OWNER_DOSSIER_FIXTURE";
  let contextReads = 0;
  let receivedInput;
  const h = await serverHarness({
    env: config({
      ELI_MINI_APP_TEXT_AI_ENABLED: "true",
      ELI_MINI_APP_OWNER_DOSSIER_ENABLED: "true",
      OPENAI_API_KEY: `sk-${"x".repeat(24)}`,
    }),
    ownerDossierContext: (ownerId, message) => {
      contextReads += 1;
      assert.equal(ownerId, OWNER_ID);
      assert.equal(message, "synthetic goal question");
      return syntheticContext;
    },
    textAi: async (input) => {
      receivedInput = input;
      return "Synthetic answer.";
    },
  });
  try {
    assert.equal((await h.request("/text-ai", { message: "synthetic goal question" })).status, 401);
    assert.equal(contextReads, 0);
    const cookie = await ownerCookie(h);
    const status = await h.request("/text-ai/status", {}, { cookie });
    assert.equal(status.status, 404);
    assert.deepEqual(await status.json(), { error: "not_found" });
    const response = await h.request("/text-ai", { message: "synthetic goal question" }, { cookie });
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: "not_found" });
    assert.equal(contextReads, 0);
    assert.equal(receivedInput, undefined);
  } finally {
    await h.close();
  }
});

test("staging rejects a foreign Telegram identity before issuing a session", async () => {
  let providerCalls = 0;
  const h = await serverHarness({
    env: config({
      ELI_MINI_APP_TEXT_AI_ENABLED: "true",
      OPENAI_API_KEY: "",
    }),
    textAi: async () => {
      providerCalls += 1;
      return "Must not be called.";
    },
  });
  try {
    const clientSession = await h.request("/session", {
      initData: signedInitData({ userId: "987654321" }),
    });
    assert.equal(clientSession.status, 403);
    assert.deepEqual(await clientSession.json(), { error: "owner_only" });
    assert.equal(clientSession.headers.get("set-cookie"), null);
    assert.equal(providerCalls, 0);
    const cookie = await ownerCookie(h);
    const response = await h.request("/text-ai", { message: "synthetic" }, { cookie });
    assert.equal(response.status, 404);
    assert.equal(providerCalls, 0);
  } finally {
    await h.close();
  }
});

test("retired mixed dossier query cannot invoke FAQ, dossier, or provider callbacks", async () => {
  const answerCalls = [];
  let providerCalls = 0;
  let contextCalls = 0;
  const h = await serverHarness({
    env: config({
      ELI_MINI_APP_TEXT_AI_ENABLED: "true",
      ELI_MINI_APP_OWNER_DOSSIER_ENABLED: "true",
      OPENAI_API_KEY: `sk-${"x".repeat(24)}`,
    }),
    ownerDossierContext: () => {
      contextCalls += 1;
      return "SYNTHETIC_CONTEXT_SHOULD_NOT_BE_USED";
    },
    ownerDossierFaq: {
      detectOwnerDossierQuestion: () => "business_mission",
      answerOwnerDossierQuestion: (ownerId, intent) => {
        assert.equal(ownerId, OWNER_ID);
        answerCalls.push(intent);
        return intent === "creation_reason"
          ? "Synthetic personal motivation."
          : "Synthetic life goal.";
      },
    },
    textAi: async () => {
      providerCalls += 1;
      return "This provider response must not be used.";
    },
  });
  try {
    const question = "Ели, освен твоята мисия да помагаш на хората, каква е моята лична мотивация да създам този бизнес и какво искам да постигна в живота си?";
    assert.equal((await h.request("/text-ai", { message: question })).status, 401);
    assert.deepEqual(answerCalls, []);

    const cookie = await ownerCookie(h);
    const response = await h.request("/text-ai", { message: question }, { cookie });
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: "not_found" });
    assert.deepEqual(answerCalls, []);
    assert.equal(contextCalls, 0);
    assert.equal(providerCalls, 0);
  } finally {
    await h.close();
  }
});

test("retired dossier FAQ route returns 404 without provider fallback", async () => {
  let providerCalls = 0;
  const h = await serverHarness({
    env: config({
      ELI_MINI_APP_TEXT_AI_ENABLED: "true",
      ELI_MINI_APP_OWNER_DOSSIER_ENABLED: "true",
      OPENAI_API_KEY: `sk-${"x".repeat(24)}`,
    }),
    ownerDossierFaq: {
      detectOwnerDossierQuestion: () => null,
      answerOwnerDossierQuestion: (_ownerId, intent) =>
        intent === "creation_reason"
          ? "Не знам потвърдената причина; можеш да я добавиш или актуализираш."
          : "Не знам потвърдени цели; можеш да ги добавиш или актуализираш.",
    },
    textAi: async () => {
      providerCalls += 1;
      return "Guessed answer.";
    },
  });
  try {
    const cookie = await ownerCookie(h);
    const response = await h.request(
      "/text-ai",
      { message: "Каква е личната ми мотивация и какво искам да постигна в живота си?" },
      { cookie },
    );
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: "not_found" });
    assert.equal(providerCalls, 0);
  } finally {
    await h.close();
  }
});

test("legacy dossier route remains 404 when owner dossier is enabled", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "eli-mini-canonical-dossier-"));
  const fixturePath = path.join(tempRoot, "fixture.json");
  const fixture = {
    schemaVersion: 1,
    facts: [
      { id: "motivation", category: "motivation", value: "SYNTHETIC_PERSONAL_MOTIVATION" },
      { id: "business-mission", category: "personal_facts", value: "SYNTHETIC_BUSINESS_MISSION" },
      { id: "financial-dream", category: "goals", value: "SYNTHETIC_LIFE_GOAL" },
      { id: "eli-relationship", category: "relationship_context", value: "SYNTHETIC_UNRELATED_FACT" },
      { id: "preferred-name", category: "personal_facts", value: "SYNTHETIC_PREFERRED_NAME" },
    ],
  };
  const originalFixture = JSON.stringify(fixture);
  await writeFile(fixturePath, originalFixture, { mode: 0o600 });
  const dossier = loadSyntheticOwnerDossierModule();
  let providerCalls = 0;
  const h = await serverHarness({
    env: config({
      ELI_MINI_APP_TEXT_AI_ENABLED: "true",
      ELI_MINI_APP_OWNER_DOSSIER_ENABLED: "true",
      OPENAI_API_KEY: `sk-${"x".repeat(24)}`,
    }),
    ownerDossierPath: fixturePath,
    ownerDossierContext: (ownerId, message) =>
      dossier.buildOwnerDossierPrompt(ownerId, message),
    ownerDossierFaq: dossier,
    textAi: async (input) => {
      providerCalls += 1;
      return `Synthetic answer using ${input.ownerDossierContext || "no dossier"}.`;
    },
  });
  try {
    const clientSession = await h.request("/session", {
      initData: signedInitData({ userId: "987654321" }),
    });
    assert.equal(clientSession.status, 403);
    assert.deepEqual(await clientSession.json(), { error: "owner_only" });
    assert.equal(clientSession.headers.get("set-cookie"), null);
    assert.equal(providerCalls, 0);

    const cookie = await ownerCookie(h);
    const questions = [
      "Каква е моята лична мотивация да създам този бизнес?",
      "Какво искам да постигна в живота си?",
      "Каква е бизнес мисията?",
      "Ели, освен твоята мисия, каква е моята лична мотивация и какво искам да постигна в живота си?",
    ];
    for (const message of questions) {
      const response = await h.request("/text-ai", { message }, { cookie });
      assert.equal(response.status, 404);
      assert.deepEqual(await response.json(), { error: "not_found" });
    }
    assert.equal(providerCalls, 0);

    const nameContextResponse = await h.request(
      "/text-ai",
      { message: "Моля използвай името ми в отговора." },
      { cookie },
    );
    assert.equal(nameContextResponse.status, 404);
    assert.equal(providerCalls, 0);
    assert.equal((await readFile(fixturePath, "utf8")), originalFixture);
  } finally {
    await h.close();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("retired dossier read route returns 404 without answering or calling AI", async () => {
  const missingPath = path.join(os.tmpdir(), `eli-mini-missing-${process.pid}`, "dossier.json");
  let faqCalls = 0;
  let providerCalls = 0;
  const h = await serverHarness({
    env: config({
      ELI_MINI_APP_TEXT_AI_ENABLED: "true",
      ELI_MINI_APP_OWNER_DOSSIER_ENABLED: "true",
      OPENAI_API_KEY: `sk-${"x".repeat(24)}`,
    }),
    ownerDossierPath: missingPath,
    ownerDossierFaq: {
      detectOwnerDossierQuestion: () => "creation_reason",
      answerOwnerDossierQuestion: () => {
        faqCalls += 1;
        return "Must not answer without readable dossier.";
      },
    },
    textAi: async () => {
      providerCalls += 1;
      return "Must not guess.";
    },
  });
  try {
    const cookie = await ownerCookie(h);
    const response = await h.request(
      "/text-ai",
      { message: "Каква е моята лична мотивация?" },
      { cookie },
    );
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: "not_found" });
    assert.equal(faqCalls, 0);
    assert.equal(providerCalls, 0);
  } finally {
    await h.close();
  }
});

test("retired AI route returns 404 regardless of key or provider configuration", async () => {
  let providerCalls = 0;
  const invalidKey = await serverHarness({
    env: config({
      ELI_MINI_APP_TEXT_AI_ENABLED: "true",
      OPENAI_API_KEY: "sk-short",
    }),
    textAi: async () => { providerCalls += 1; return "never"; },
  });
  try {
    const cookie = await ownerCookie(invalidKey);
    const response = await invalidKey.request("/text-ai", { message: "synthetic" }, { cookie });
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: "not_found" });
    assert.equal(providerCalls, 0);
  } finally {
    await invalidKey.close();
  }

  const failingProvider = await serverHarness({
    env: config({
      ELI_MINI_APP_TEXT_AI_ENABLED: "true",
      OPENAI_API_KEY: `sk-${"x".repeat(24)}`,
    }),
    textAi: async () => {
      providerCalls += 1;
      throw new Error("private provider error detail");
    },
  });
  try {
    const cookie = await ownerCookie(failingProvider);
    const response = await failingProvider.request("/text-ai", { message: "synthetic" }, { cookie });
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: "not_found" });
    assert.equal(providerCalls, 0);
  } finally {
    await failingProvider.close();
  }
});

test("retired text AI route never consumes provider quota or invokes the provider", async () => {
  let providerCalls = 0;
  const h = await serverHarness({
    env: config({
      ELI_MINI_APP_TEXT_AI_ENABLED: "true",
      OPENAI_API_KEY: `sk-${"x".repeat(24)}`,
    }),
    textAi: async () => { providerCalls += 1; return "Synthetic reply."; },
  });
  try {
    const cookie = await ownerCookie(h);
    for (let index = 0; index < 20; index += 1) {
      const response = await h.request("/text-ai", { message: "synthetic" }, { cookie });
      assert.equal(response.status, 404);
      assert.deepEqual(await response.json(), { error: "not_found" });
    }
    const dailyLimited = await h.request("/text-ai", { message: "synthetic" }, { cookie });
    assert.equal(dailyLimited.status, 404);
    assert.equal(providerCalls, 0);
  } finally {
    await h.close();
  }
});

test("OpenAI adapter selects gpt-4o-mini with 400 tokens and never exposes provider error bodies", async () => {
  let captured;
  const adapter = createOpenAiTextAiAdapter(`sk-${"x".repeat(24)}`, async (url, init) => {
    captured = { url: String(url), init, body: JSON.parse(init.body) };
    return new Response(JSON.stringify({ choices: [{ message: { content: "Synthetic provider answer." } }] }));
  });
  assert.equal(await adapter({ message: "synthetic", language: "bg" }), "Synthetic provider answer.");
  assert.equal(captured.url, "https://api.openai.com/v1/chat/completions");
  assert.equal(captured.body.model, "gpt-4o-mini");
  assert.equal(captured.body.max_tokens, 400);
  assert.equal(captured.body.messages.at(-1).content, "synthetic");
  assert.match(captured.body.messages[0].content, /no access to synchronized profile/i);
  assert.doesNotMatch(captured.body.messages[0].content, /OWNER_MEMORY/i);
  assert.ok(captured.init.signal);

  const legacyAdapter = createOpenAiTextAiAdapter(`sk-${"x".repeat(24)}`, async (_url, init) => {
    captured = { body: JSON.parse(init.body) };
    return new Response(JSON.stringify({ choices: [{ message: { content: "Synthetic answer." } }] }));
  });
  await legacyAdapter({
    message: "synthetic goal question",
    language: "en",
    ownerDossierContext: "SYNTHETIC_OWNER_DOSSIER_FIXTURE",
  });
  assert.match(captured.body.messages[0].content, /SYNTHETIC_OWNER_DOSSIER_FIXTURE/);
  assert.match(captured.body.messages[0].content, /no synchronized chat history/i);

  const failing = createOpenAiTextAiAdapter(`sk-${"x".repeat(24)}`, async () =>
    new Response("synthetic provider detail must not surface", { status: 500 }));
  await assert.rejects(failing({ message: "synthetic", language: "en" }), /provider_unavailable/);
});

test("profile/progress GET remains unavailable even with a valid owner session", async () => {
  const h = await serverHarness();
  try {
    const cookie = await ownerCookie(h);
    const response = await h.request("/profile-progress", undefined, {
      cookie,
      method: "GET",
    });
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: "not_found" });
  } finally {
    await h.close();
  }
});

test("staging profile snapshot reads owner data only and rejects client identities", async () => {
  const snapshots = new Map([
    [OWNER_ID, { profile: { label: "synthetic owner" }, ownerDossier: ["owner-only"] }],
    ["987654321", { profile: { label: "synthetic client one" } }],
    ["876543219", { profile: { label: "synthetic client two" } }],
  ]);
  const h = await serverHarness({
    readProfileSnapshot: async userId => snapshots.get(userId),
  });
  try {
    const login = await h.request("/session", { initData: signedInitData() });
    assert.equal(login.status, 200);
    const cookie = login.headers.get("set-cookie").split(";")[0];
    const response = await h.request("/profile", {}, { cookie });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).mode, "read_only");

    for (const userId of ["987654321", "876543219"]) {
      const client = await h.request("/session", { initData: signedInitData({ userId }) });
      assert.equal(client.status, 403);
      const stale = await h.request("/profile", {}, { cookie: legacyCookieFor(userId) });
      assert.equal(stale.status, 403);
    }
  } finally {
    await h.close();
  }
});

test("production Mini App sessions are per-user and bind profile reads and chat claims to that user", async () => {
  const customerId = "987654321";
  const bridgeSecret = "synthetic-api-bridge-key-with-more-than-32-characters";
  const seenProfileIds = [];
  let chatClaim;
  const h = await serverHarness({
    env: config({ NODE_ENV: "production", ELI_MINI_APP_STAGE: "production" }),
    readProfileSnapshot: async userId => {
      seenProfileIds.push(userId);
      return { profile: { label: "synthetic customer" } };
    },
    bridgeSecret,
    bridgeFetch: async (_url, init) => {
      const bearer = init.headers.Authorization.slice("Bearer ".length);
      const encodedClaims = bearer.split(".")[0];
      const claims = JSON.parse(Buffer.from(encodedClaims, "base64url").toString("utf8"));
      chatClaim = { userId: claims.sub, path: claims.path };
      return new Response(JSON.stringify({
        ok: true,
        reply: "synthetic customer reply",
        kind: "eli_text",
      }), { status: 200 });
    },
  });
  try {
    const login = await h.request("/session", {
      initData: signedInitData({ userId: customerId }),
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get("set-cookie").split(";")[0];

    const repeatedSession = await h.request(
      "/session",
      { initData: signedInitData({ userId: customerId }) },
      { cookie },
    );
    assert.equal(repeatedSession.status, 200);
    assert.equal(repeatedSession.headers.get("set-cookie"), null);

    const profile = await h.request("/profile", {}, { cookie });
    assert.equal(profile.status, 200);
    assert.deepEqual(seenProfileIds, [customerId]);

    const chat = await h.request("/chat", {
      message: "synthetic customer prompt",
      mode: "text",
      turnId: "f9b2d7a0-0e22-4e10-a987-7eea4ebf0667",
    }, { cookie });
    assert.equal(chat.status, 200);
    assert.equal((await chat.json()).reply, "synthetic customer reply");
    assert.equal(chatClaim.userId, customerId);
    assert.equal(chatClaim.path, "/internal/mini-app/text-turn");
  } finally {
    await h.close();
  }
});

test("API signs the verified session subject for the loopback bot bridge", async () => {
  const bridgeSecret = "synthetic-api-bridge-key-with-more-than-32-characters";
  const { verifyClaim } = require("../../../bot/miniAppBridgeAuth.js");
  let bridgeCall;
  const h = await serverHarness({
    bridgeSecret,
    bridgeFetch: async (url, init) => {
      bridgeCall = { url: String(url), init };
      const claim = init.headers.Authorization.slice("Bearer ".length);
      const verified = verifyClaim(claim, bridgeSecret, Math.floor(Date.now() / 1000));
      assert.equal(verified.userId, OWNER_ID);
      assert.equal(init.body, "{}");
      return new Response(JSON.stringify({
        ok: true,
        snapshot: { profile: { label: "synthetic bot-owned data" } },
      }));
    },
  });
  try {
    const login = await h.request("/session", {
      initData: signedInitData(),
    });
    const cookie = login.headers.get("set-cookie").split(";")[0];
    const response = await h.request("/profile", {}, { cookie });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      mode: "read_only",
      snapshot: { profile: { label: "synthetic bot-owned data" } },
    });
    assert.equal(bridgeCall.url, "http://127.0.0.1:3001/internal/mini-app/profile-snapshot");
  } finally {
    await h.close();
  }
});

test("Mini App mutation forwards only validated action and payload with a mutation-bound claim", async () => {
  const bridgeSecret = "synthetic-api-bridge-key-with-more-than-32-characters";
  const { verifyClaim } = require("../../../bot/miniAppBridgeAuth.js");
  let call;
  const h = await serverHarness({
    bridgeSecret,
    bridgeFetch: async (url, init) => {
      const claim = init.headers.Authorization.slice("Bearer ".length);
      const verified = verifyClaim(claim, bridgeSecret, Math.floor(Date.now() / 1000));
      call = { url: String(url), verified, body: JSON.parse(init.body) };
      return new Response(JSON.stringify({
        ok: true, action: "profile.update", record: { age: 40 },
      }));
    },
  });
  try {
    const login = await h.request("/session", { initData: signedInitData() });
    const cookie = login.headers.get("set-cookie").split(";")[0];
    const payload = { action: "profile.update", payload: { field: "age", value: "40" } };
    const response = await h.request("/mutations", payload, { cookie });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      ok: true, action: "profile.update", record: { age: 40 },
    });
    assert.equal(call.url, "http://127.0.0.1:3001/internal/mini-app/mutate");
    assert.equal(call.verified.userId, OWNER_ID);
    assert.equal(call.verified.path, "/internal/mini-app/mutate");
    assert.deepEqual(call.body, payload);
    assert.equal("userId" in call.body, false);
  } finally {
    await h.close();
  }
});

test("owner chat requires the protected owner session before calling the bot bridge", async () => {
  let forwarded;
  const h = await serverHarness({
    bridgeSecret: "synthetic-bridge-secret-with-more-than-thirty-two-characters",
    bridgeFetch: async (url, init) => {
      forwarded = { url, body: JSON.parse(init.body) };
      return new Response(JSON.stringify({
        ok: true,
        reply: "Синтетичен отговор от bot engine.",
        kind: "eli_text",
      }), { status: 200 });
    },
  });
  try {
    const body = {
      message: "synthetic question",
      mode: "text",
      turnId: "f9b2d7a0-0e22-4e10-a987-7eea4ebf0667",
    };
    const unauthenticated = await h.request("/chat", body);
    assert.equal(unauthenticated.status, 401);
    const foreignInitData = await h.request("/session", {
      initData: signedInitData({ userId: "987654321" }),
    });
    assert.equal(foreignInitData.status, 403);
    assert.equal(foreignInitData.headers.get("set-cookie"), null);
    const foreignSession = await h.request("/chat", body, {
      cookie: legacyCookieFor("987654321"),
    });
    assert.equal(foreignSession.status, 403);
    assert.equal(forwarded, undefined);

    const cookie = await ownerCookie(h);
    const response = await h.request("/chat", body, { cookie });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      reply: "Синтетичен отговор от bot engine.",
      kind: "eli_text",
    });
    assert.equal(forwarded.url, "http://127.0.0.1:3001/internal/mini-app/text-turn");
    assert.deepEqual(forwarded.body, {
      message: "synthetic question",
      mode: "text",
      turnId: "f9b2d7a0-0e22-4e10-a987-7eea4ebf0667",
    });
  } finally {
    await h.close();
  }
});
