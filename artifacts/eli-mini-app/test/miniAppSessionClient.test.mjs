import assert from "node:assert/strict";
import test from "node:test";
import {
  getOwnerTextAiStatus,
  MiniAppStageError,
  sendOwnerDemoChat,
  sendOwnerTextAi,
  uploadOwnerDemoMedia,
} from "../src/miniAppSessionClient.ts";
import { translate } from "../src/i18n.ts";

const initData = "signed-data-fixture-not-a-real-credential";

test("owner demo chat obtains an idempotent session and consumes only the fixed mock envelope", async () => {
  const requests = [];
  const fetchMock = async (url, init) => {
    requests.push({ url, init });
    return String(url).endsWith("/session")
      ? new Response(JSON.stringify({ ok: true, expiresAt: "2026-10-22T00:10:00.000Z" }))
      : new Response(JSON.stringify({ reply: "Fixed staging mock reply.", demo: true }));
  };
  const result = await sendOwnerDemoChat(initData, "synthetic text", "en", fetchMock);
  assert.deepEqual(result, { reply: "Fixed staging mock reply.", demo: true });
  assert.deepEqual(requests.map(({ url }) => url), ["/api/mini-app/session", "/api/mini-app/demo-chat"]);
  for (const { init } of requests) {
    assert.equal(init.credentials, "same-origin");
    assert.equal(init.cache, "no-store");
    assert.equal(init.redirect, "error");
  }
  assert.deepEqual(JSON.parse(requests[0].init.body), { initData });
  assert.deepEqual(JSON.parse(requests[1].init.body), { message: "synthetic text", language: "en" });
});

test("owner demo client surfaces disabled and unauthorized staging errors without falling back", async () => {
  for (const [status, body, expected] of [
    [404, { error: "not_found" }, "not_found"],
    [403, { error: "owner_only" }, "owner_only"],
  ]) {
    await assert.rejects(
      sendOwnerDemoChat(initData, "synthetic text", "bg", async () => new Response(JSON.stringify(body), { status })),
      (error) => error instanceof MiniAppStageError && error.status === status && error.code === expected,
    );
  }
});

test("image upload uses same-origin credentials and verifies the mock-only response", async () => {
  const requests = [];
  const file = new File([new Uint8Array([0xff, 0xd8, 0xff])], "sample.jpg", { type: "image/jpeg" });
  const fetchMock = async (url, init) => {
    requests.push({ url, init });
    return String(url).endsWith("/session")
      ? new Response(JSON.stringify({ ok: true, expiresAt: "2026-10-22T00:10:00.000Z" }))
      : new Response(JSON.stringify({ reply: "Fixed mock: not analyzed.", mediaType: "image", staged: true, demo: true }));
  };
  const result = await uploadOwnerDemoMedia(initData, "image", file, "bg", "", fetchMock);
  assert.equal(result.demo, true);
  assert.equal(result.mediaType, "image");
  assert.equal(requests[1].url, "/api/mini-app/media/image");
  assert.equal(requests[1].init.credentials, "same-origin");
  assert.ok(requests[1].init.body instanceof FormData);
});

test("empty signed initData is rejected before any request", async () => {
  let calls = 0;
  await assert.rejects(sendOwnerDemoChat("", "synthetic", "bg", async () => { calls += 1; }));
  assert.equal(calls, 0);
});

test("offline demo send fails once without a backend or provider retry", async () => {
  const requests = [];
  await assert.rejects(
    sendOwnerDemoChat(initData, "synthetic offline text", "bg", async (url) => {
      requests.push(String(url));
      if (String(url).endsWith("/session")) {
        return new Response(JSON.stringify({ ok: true, expiresAt: "2026-10-22T00:10:00.000Z" }));
      }
      throw new TypeError("offline");
    }),
    (error) => error instanceof MiniAppStageError && error.code === "network_unavailable",
  );
  assert.deepEqual(requests, ["/api/mini-app/session", "/api/mini-app/demo-chat"]);
});

test("owner AI status check never calls the AI endpoint and distinguishes mock from live", async () => {
  for (const mode of ["mock", "test_ai"]) {
    const paths = [];
    const result = await getOwnerTextAiStatus(initData, async (url, init) => {
      paths.push({ url: String(url), method: init.method });
      return String(url).endsWith("/session")
        ? new Response(JSON.stringify({ ok: true, expiresAt: "2026-10-22T00:10:00.000Z" }))
        : new Response(JSON.stringify({ mode, ...(mode === "test_ai" ? { model: "gpt-4o-mini" } : {}) }));
    });
    assert.equal(result, mode);
    assert.deepEqual(paths, [
      { url: "/api/mini-app/session", method: "POST" },
      { url: "/api/mini-app/text-ai/status", method: "POST" },
    ]);
    assert.equal(paths.some(({ url }) => url.endsWith("/text-ai") && !url.endsWith("/status")), false);
  }
});

test("session recovery and mock fallback notices are localized in Bulgarian and English", () => {
  for (const language of ["bg", "en"]) {
    assert.ok(translate(language, "stageSessionError").length > 20);
    assert.ok(translate(language, "stageSwitchedToMock").length > 20);
    assert.ok(translate(language, "stageProviderUncertain").length > 20);
    assert.ok(translate(language, "dismiss").length > 0);
  }
});

test("live AI is invoked only by explicit send and fails without mock fallback", async () => {
  const requests = [];
  const result = await sendOwnerTextAi(initData, "synthetic test", "en", async (url, init) => {
    requests.push({ url: String(url), init });
    return String(url).endsWith("/session")
      ? new Response(JSON.stringify({ ok: true, expiresAt: "2026-10-22T00:10:00.000Z" }))
      : new Response(JSON.stringify({ reply: "Synthetic live test response.", mode: "test_ai", model: "gpt-4o-mini" }));
  });
  assert.deepEqual(result, {
    reply: "Synthetic live test response.",
    mode: "test_ai",
    model: "gpt-4o-mini",
  });
  assert.deepEqual(requests.map(({ url }) => url), ["/api/mini-app/session", "/api/mini-app/text-ai"]);
  assert.equal(JSON.parse(requests[1].init.body).message, "synthetic test");
  assert.equal(requests[1].init.credentials, "same-origin");
  assert.equal(requests[1].init.redirect, "error");

  await assert.rejects(
    () => sendOwnerTextAi(initData, "synthetic test", "bg", async (url) => {
      if (String(url).endsWith("/session")) {
        return new Response(JSON.stringify({ ok: true, expiresAt: "2026-10-22T00:10:00.000Z" }));
      }
      return new Response(JSON.stringify({ error: "text_ai_provider_unavailable" }), { status: 503 });
    }),
    (error) => error instanceof MiniAppStageError && error.status === 503,
  );
});
