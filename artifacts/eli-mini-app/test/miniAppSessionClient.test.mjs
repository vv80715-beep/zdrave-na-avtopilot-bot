import assert from "node:assert/strict";
import test from "node:test";
import {
  getMiniAppProfileSnapshot,
  isMiniAppModeAllowed,
  getOwnerTextAiStatus,
  MiniAppStageError,
  sendMiniAppTextTurn,
  requestMiniAppCoaching,
  sendMiniAppVoiceTurn,
  mutateMiniAppRecord,
  sendOwnerDemoChat,
  sendOwnerTextAi,
  uploadOwnerDemoMedia,
} from "../src/miniAppSessionClient.ts";
import { translate } from "../src/i18n.ts";

const initData = "signed-data-fixture-not-a-real-credential";

test("coaching requests use the authenticated session and the bot coaching endpoint", async () => {
  const requests = [];
  const result = await requestMiniAppCoaching(initData, "weeklyreview", async (url, init) => {
    requests.push({ url: String(url), init });
    return String(url).endsWith("/session")
      ? new Response(JSON.stringify({ ok: true, expiresAt: "2026-10-22T00:10:00.000Z" }))
      : new Response(JSON.stringify({ kind: "coaching", text: "Synthetic review" }));
  });
  assert.deepEqual(result, { kind: "coaching", text: "Synthetic review" });
  assert.deepEqual(requests.map(({ url }) => url), [
    "/api/mini-app/session", "/api/mini-app/coaching",
  ]);
  assert.equal(requests[1].init.credentials, "same-origin");
  assert.deepEqual(JSON.parse(requests[1].init.body), { action: "weeklyreview" });
});

test("Mini App mutations obtain an owner session and send no client identity", async () => {
  const requests = [];
  const result = await mutateMiniAppRecord(initData, {
    action: "profile.update",
    payload: { field: "age", value: "40" },
  }, async (url, init) => {
    requests.push({ url: String(url), init });
    return String(url).endsWith("/session")
      ? new Response(JSON.stringify({ ok: true, expiresAt: "2026-10-22T00:10:00.000Z" }))
      : new Response(JSON.stringify({
        ok: true, action: "profile.update", record: { age: 40 },
      }));
  });
  assert.equal(result.action, "profile.update");
  assert.deepEqual(requests.map(({ url }) => url), [
    "/api/mini-app/session", "/api/mini-app/mutations",
  ]);
  assert.equal(requests[1].init.credentials, "same-origin");
  assert.deepEqual(JSON.parse(requests[1].init.body), {
    action: "profile.update", payload: { field: "age", value: "40" },
  });
});

test("reminder mutations use authenticated session payloads without browser identity", async () => {
  const requests = [];
  await mutateMiniAppRecord(initData, {
    action: "reminder.create",
    payload: { title: "Drink water", time: "09:05", days: "пн, ср, пт", category: "water" },
  }, async (url, init) => {
    requests.push({ url: String(url), init });
    return String(url).endsWith("/session")
      ? new Response(JSON.stringify({ ok: true, expiresAt: "2026-10-22T00:10:00.000Z" }))
      : new Response(JSON.stringify({ ok: true, action: "reminder.create", record: { id: "reminder-1" } }));
  });
  assert.deepEqual(requests.map(({ url }) => url), [
    "/api/mini-app/session", "/api/mini-app/mutations",
  ]);
  assert.equal(requests[1].init.credentials, "same-origin");
  assert.deepEqual(JSON.parse(requests[1].init.body), {
    action: "reminder.create",
    payload: { title: "Drink water", time: "09:05", days: "пн, ср, пт", category: "water" },
  });
  assert.equal(JSON.stringify(JSON.parse(requests[1].init.body)).includes("telegramId"), false);
});

test("Mini App text turn uses the bot chat route and sends no browser identity", async () => {
  const requests = [];
  const result = await sendMiniAppTextTurn(initData, "synthetic question", async (url, init) => {
    requests.push({ url: String(url), init });
    return String(url).endsWith("/session")
      ? new Response(JSON.stringify({ ok: true, expiresAt: "2026-10-22T00:10:00.000Z" }))
      : new Response(JSON.stringify({ reply: "synthetic bot reply", kind: "eli_text" }));
  });
  assert.deepEqual(result, { reply: "synthetic bot reply", kind: "eli_text" });
  assert.deepEqual(requests.map(request => request.url), [
    "/api/mini-app/session",
    "/api/mini-app/chat",
  ]);
  const turnBody = JSON.parse(requests[1].init.body);
  assert.equal(turnBody.message, "synthetic question");
  assert.equal(turnBody.mode, "text");
  assert.match(turnBody.turnId, /^[0-9a-f-]{36}$/i);
  assert.equal(requests[1].init.credentials, "same-origin");
});

test("profile client loads read-only data through the signed session without sending a Telegram ID", async () => {
  const requests = [];
  const snapshot = {
    profile: { firstName: "Synthetic" },
    legacyMemory: null,
    relationshipMemory: [],
    healthLogs: [],
    checkins: [],
    reminders: [],
    entitlement: {
      plan: "free",
      state: "trial_expired",
      allowedModes: [],
      canChat: false,
      planExpiresAt: null,
      trialExpiresAt: null,
      backendVerified: true,
    },
    mode: "text",
  };
  const result = await getMiniAppProfileSnapshot(initData, async (url, init) => {
    requests.push({ url: String(url), init });
    return String(url).endsWith("/session")
      ? new Response(JSON.stringify({ ok: true, expiresAt: "2026-10-22T00:10:00.000Z" }))
      : new Response(JSON.stringify({ mode: "read_only", snapshot }));
  });
  assert.deepEqual(result, snapshot);
  assert.deepEqual(requests.map((request) => request.url), [
    "/api/mini-app/session",
    "/api/mini-app/profile",
  ]);
  assert.deepEqual(JSON.parse(requests[1].init.body), {});
  assert.equal(requests[1].init.credentials, "same-origin");
  assert.equal(requests[1].init.cache, "no-store");
});

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

test("voice turn uploads multipart audio with session auth and returns bot reply media", async () => {
  const requests = [];
  const blob = new Blob([new Uint8Array([0x1a, 0x45, 0xdf, 0xa3])], { type: "audio/webm" });
  const result = await sendMiniAppVoiceTurn(
    initData, blob, "sample.webm", "bg", "voice", "моля, кратко",
    async (url, init) => {
      requests.push({ url: String(url), init });
      return String(url).endsWith("/session")
        ? new Response(JSON.stringify({ ok: true, expiresAt: "2026-10-22T00:10:00.000Z" }))
        : new Response(JSON.stringify({
          transcript: "Синтетична фраза.",
          reply: "Гласов отговор от Ели.",
          kind: "voice",
          mediaType: "voice",
          staged: false,
          demo: false,
          media: { type: "audio", mimeType: "audio/ogg", data: "c3ludGhldGlj" },
        }));
    },
  );
  assert.equal(result.kind, "voice");
  assert.equal(result.transcript, "Синтетична фраза.");
  assert.equal(result.media?.type, "audio");
  assert.deepEqual(requests.map(({ url }) => url), [
    "/api/mini-app/session", "/api/mini-app/media/voice",
  ]);
  assert.equal(requests[1].init.credentials, "same-origin");
  assert.ok(requests[1].init.body instanceof FormData);
  assert.equal(requests[1].init.body.get("mode"), "voice");
  assert.equal(requests[1].init.body.get("language"), "bg");
  assert.equal(requests[1].init.body.get("prompt"), "моля, кратко");
  assert.match(requests[1].init.body.get("turnId"), /^[0-9a-f-]{36}$/i);
  assert.equal(requests[1].init.body.get("file").type, "audio/webm");
});

test("trial entitlement allows text only and unverified plans never unlock paid modes", () => {
  const trial = {
    plan: "five_day_trial", state: "active", allowedModes: ["text"], canChat: true,
    planExpiresAt: null, trialExpiresAt: null, backendVerified: true,
  };
  assert.equal(isMiniAppModeAllowed(trial, "text"), true);
  assert.equal(isMiniAppModeAllowed(trial, "voice"), false);
  assert.equal(isMiniAppModeAllowed(trial, "avatar"), false);
  assert.equal(isMiniAppModeAllowed({ ...trial, backendVerified: false, allowedModes: ["text", "voice", "avatar"] }, "avatar"), false);
  assert.equal(isMiniAppModeAllowed({ ...trial, canChat: false }, "text"), false);
});

test("text, voice-output, and avatar buttons all dispatch to the bot text engine with selected mode", async () => {
  for (const mode of ["text", "voice", "avatar"]) {
    const requests = [];
    const payload = mode === "voice"
      ? { reply: "Synthetic spoken answer", kind: "voice", media: { type: "audio", mimeType: "audio/ogg", data: "c3ludGhldGlj" } }
      : mode === "avatar"
        ? { reply: "Synthetic avatar script", kind: "avatar", media: { type: "video", url: "https://media.example/synthetic.mp4" } }
        : { reply: "Synthetic text answer", kind: "eli_text" };
    const result = await sendMiniAppTextTurn(initData, "synthetic question", async (url, init) => {
      requests.push({ url: String(url), init });
      return String(url).endsWith("/session")
        ? new Response(JSON.stringify({ ok: true, expiresAt: "2026-10-22T00:10:00.000Z" }))
        : new Response(JSON.stringify(payload));
    }, mode);
    assert.deepEqual(JSON.parse(requests[1].init.body).mode, mode);
    assert.equal(requests[1].url, "/api/mini-app/chat");
    assert.equal(result.kind, payload.kind);
    assert.equal(result.reply, payload.reply);
  }
});

test("avatar video URLs and voice media are validated before rendering", async () => {
  await assert.rejects(sendMiniAppTextTurn(initData, "synthetic", async (url) =>
    String(url).endsWith("/session")
      ? new Response(JSON.stringify({ ok: true, expiresAt: "2026-10-22T00:10:00.000Z" }))
      : new Response(JSON.stringify({ reply: "answer", kind: "avatar", media: { type: "video", url: "http://unsafe.example/video.mp4" } })),
  "avatar"), error => error instanceof MiniAppStageError && error.code === "invalid_response");
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
        : new Response(JSON.stringify({
          mode,
          ownerDossierContext: false,
          ...(mode === "test_ai" ? { model: "gpt-4o-mini" } : {}),
        }));
    });
    assert.deepEqual(result, { mode, ownerDossierContext: false });
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

test("dossier FAQ response is accepted without falsely requiring GPT model metadata", async () => {
  const result = await sendOwnerTextAi(initData, "synthetic dossier question", "bg", async (url) => {
    return String(url).endsWith("/session")
      ? new Response(JSON.stringify({ ok: true, expiresAt: "2026-10-22T00:10:00.000Z" }))
      : new Response(JSON.stringify({
          reply: "Synthetic dossier FAQ answer.",
          mode: "owner_dossier_faq",
        }));
  });
  assert.deepEqual(result, {
    reply: "Synthetic dossier FAQ answer.",
    mode: "owner_dossier_faq",
  });
});
