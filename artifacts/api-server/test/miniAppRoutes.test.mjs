import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import cors from "cors";
import express from "express";
import test from "node:test";
import {
  createMiniAppRouter,
  miniAppConfigEnabled,
  mountMiniAppRoutes,
} from "../src/routes/miniApp.ts";

const TOKEN = "offline-fake-telegram-token-never-used";
const SESSION_SECRET = "offline-session-secret-for-tests-only-000000";
const OWNER_ID = "123456789";
const ORIGIN = "https://eli-stage.replit.dev";
const NOW_SECONDS = 1_800_000_000;

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

async function serverHarness({ env = config(), now = () => NOW_SECONDS * 1000, media } = {}) {
  const app = express();
  const mounted = mountMiniAppRoutes(app, env, { now, media });
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
    },
  };
}

async function ownerCookie(h) {
  const response = await h.request("/session", { initData: signedInitData() });
  assert.equal(response.status, 200);
  return response.headers.get("set-cookie").split(";")[0];
}

function imageForm(bytes, { mime = "image/jpeg", filename = "photo.jpg" } = {}) {
  const form = new FormData();
  form.set("file", new Blob([bytes], { type: mime }), filename);
  form.set("language", "bg");
  return form;
}

test("staging API is not mounted when the flag, stage, owner, origin, or secrets are missing", async () => {
  assert.equal(miniAppConfigEnabled(config({ ELI_MINI_APP_SESSION_ENABLED: "false" })), false);
  assert.equal(miniAppConfigEnabled(config({ NODE_ENV: "production" })), false);
  assert.equal(miniAppConfigEnabled(config({ OWNER_TELEGRAM_ID: "" })), false);
  assert.equal(miniAppConfigEnabled(config({ TELEGRAM_BOT_TOKEN: "" })), false);
  assert.equal(miniAppConfigEnabled(config({ SESSION_SECRET: "" })), false);
  assert.equal(miniAppConfigEnabled(config({ ELI_MINI_APP_ORIGIN: "http://eli-stage.replit.dev" })), false);
  assert.equal(miniAppConfigEnabled(config({ ELI_MINI_APP_ORIGIN: "https://localhost" })), false);

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

test("valid owner initData issues a secure short-lived session; session serves only fixed demo text", async () => {
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

    const originalFetch = globalThis.fetch;
    let externalCalls = 0;
    globalThis.fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.hostname !== "127.0.0.1") {
        externalCalls += 1;
        throw new Error("External producers are disabled in this test.");
      }
      return originalFetch(input, init);
    };
    let demo;
    try {
      demo = await h.request("/demo-chat", { message: "private health detail", language: "en" }, { cookie });
    } finally {
      globalThis.fetch = originalFetch;
    }
    assert.equal(externalCalls, 0);
    assert.equal(demo.status, 200);
    assert.deepEqual(await demo.json(), {
      reply: "This is a fixed owner-only demo reply. No AI request was made.",
      demo: true,
    });

    const replay = await h.request("/session", { initData: signedInitData() });
    assert.equal(replay.status, 401);
  } finally {
    await h.close();
  }
});

test("rejects forged, expired, and non-owner initData", async () => {
  const h = await serverHarness();
  try {
    const forged = new URLSearchParams(signedInitData());
    forged.set("user", JSON.stringify({ id: OWNER_ID, first_name: "forged" }));
    assert.equal((await h.request("/session", { initData: forged.toString() })).status, 401);
    assert.equal((await h.request("/session", {
      initData: signedInitData({ authDate: NOW_SECONDS - 301 }),
    })).status, 401);
    assert.equal((await h.request("/session", {
      initData: signedInitData({ userId: "987654321" }),
    })).status, 403);
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
    env: config({ ELI_MINI_APP_MEDIA_AI_ENABLED: "true" }),
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
    assert.deepEqual(await valid.json(), { reply: "mock description", mediaType: "image", staged: true });
    assert.equal(providerCalls, 1);
  } finally {
    await h.close();
  }
});

test("media upload rejects image size overflow before mock processing", async () => {
  let providerCalls = 0;
  const h = await serverHarness({
    env: config({ ELI_MINI_APP_MEDIA_AI_ENABLED: "true" }),
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
    env: config({ ELI_MINI_APP_MEDIA_AI_ENABLED: "true" }),
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
