import assert from "node:assert/strict";
import test from "node:test";
import {
  getReplyLabelKey,
  getUserMessageTimeKey,
  showPreparedChatExamples,
} from "../src/chatPresentation.ts";
import { translate } from "../src/i18n.ts";

test("verified live replies use a GPT-4o-mini test label in both languages", () => {
  const key = getReplyLabelKey("test_ai");
  assert.equal(key, "liveAiReplyLabel");
  assert.equal(translate("bg", key), "ЕЛИ AI — GPT-4o-mini · тестов режим");
  assert.equal(translate("en", key), "ELI AI — GPT-4o-mini · TEST MODE");
  assert.equal(translate("bg", "liveTextModeNotice").includes("само демо"), false);
  assert.equal(translate("en", "liveTextModeNotice").includes("text demo"), false);
});

test("only mock replies use the fixed demo label in both languages", () => {
  const key = getReplyLabelKey("mock");
  assert.equal(key, "fixedMockReply");
  assert.equal(translate("bg", key), "ФИКСИРАН ДЕМО ОТГОВОР — БЕЗ AI");
  assert.equal(translate("en", key), "FIXED DEMO REPLY — NO AI");
});

test("failed or unknown reply sources are never labeled as AI or mock", () => {
  assert.equal(getReplyLabelKey("unknown"), null);
  assert.equal(getReplyLabelKey(undefined), null);
});

test("API-delivered user messages never receive a local-only status", () => {
  const apiKey = getUserMessageTimeKey("api");
  assert.equal(apiKey, "apiMessageTime");
  assert.equal(translate("bg", apiKey), "изпратено към тестовия чат");
  assert.equal(translate("en", apiKey), "sent to the test chat");
  assert.equal(translate("bg", getUserMessageTimeKey("local")), "локално · не е изпратено");
  assert.equal(getUserMessageTimeKey(undefined), null);
});

test("prepared example bubbles are hidden only in live owner chat", () => {
  assert.equal(showPreparedChatExamples("live"), false);
  assert.equal(showPreparedChatExamples("mock"), true);
  assert.equal(showPreparedChatExamples("local"), true);
  assert.equal(showPreparedChatExamples("unavailable"), true);
});
