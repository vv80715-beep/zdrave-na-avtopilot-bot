import type { MiniAppMutationInput, MiniAppMutationResponse } from "@workspace/api-client-react";

export type MiniAppLanguage = "bg" | "en";
export type MiniAppTurnMode = "text" | "voice" | "avatar";
export type MiniAppCoachingAction = "coach" | "motivate" | "nextstep" | "weeklyreview";
export type MiniAppCoachingResult = { kind: "coaching" | "no_data" | "access_denied"; text: string };
export type OwnerTextAiMode = "mock" | "test_ai";
export type OwnerTextAiStatus = {
  mode: OwnerTextAiMode;
  ownerDossierContext: boolean;
};
export type OwnerTextAiResult = {
  reply: string;
  mode: "owner_dossier_faq";
} | {
  reply: string;
  mode: "test_ai";
  model: "gpt-4o-mini";
};
export type OwnerDemoMediaResult = {
  reply: string;
  transcript?: string;
  mediaType: "image" | "voice";
  staged: true;
  demo: true;
};
export type MiniAppVoiceTurnResult = {
  transcript: string;
  reply: string;
  kind: "eli_text" | "voice" | "avatar" | "access_denied" | "transcription_unclear";
  media?: { type: "audio"; mimeType: "audio/ogg"; data: string } | { type: "video"; url: string };
};
export type MiniAppProfileSnapshot = {
  profile: Record<string, unknown> | null;
  legacyMemory: Record<string, unknown> | null;
  relationshipMemory: Array<Record<string, unknown>>;
  healthLogs: Array<Record<string, unknown>>;
  checkins: Array<Record<string, unknown>>;
  reminders: Array<Record<string, unknown>>;
  history?: Array<{ role: "user" | "assistant"; content: string }>;
  entitlement: {
    plan: string;
    state: string;
    allowedModes: string[];
    canChat: boolean;
    planExpiresAt: number | null;
    trialExpiresAt: number | null;
    backendVerified: boolean;
  };
  mode: string;
  ownerDossier?: Array<Record<string, unknown>>;
};

export class MiniAppStageError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, status: number) {
    super(code);
    this.code = code;
    this.status = status;
    this.name = "MiniAppStageError";
  }
}

type FetchLike = typeof fetch;

async function sameOriginRequest(
  url: string,
  init: RequestInit,
  fetchFn: FetchLike,
  timeoutMs = 15_000,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchFn(url, {
      ...init,
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
      signal: controller.signal,
    });
  } catch (error) {
    if (controller.signal.aborted) throw new MiniAppStageError("request_timeout", 0);
    throw new MiniAppStageError("network_unavailable", 0);
  } finally {
    clearTimeout(timer);
  }
}

async function responseBody(response: Response): Promise<Record<string, unknown>> {
  try {
    const body = await response.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new Error("invalid_response");
    }
    return body as Record<string, unknown>;
  } catch {
    throw new MiniAppStageError("invalid_response", response.status);
  }
}

function safeErrorCode(body: Record<string, unknown>): string {
  return typeof body.error === "string" && /^[a-z0-9_]{1,48}$/.test(body.error)
    ? body.error
    : "request_failed";
}

export async function ensureOwnerSession(
  initData: string,
  fetchFn: FetchLike = fetch,
): Promise<void> {
  const signedData = initData.trim();
  if (!signedData || signedData.length > 8192) {
    throw new MiniAppStageError("telegram_auth_required", 0);
  }
  const response = await sameOriginRequest("/api/mini-app/session", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ initData: signedData }),
  }, fetchFn);
  const body = await responseBody(response);
  if (!response.ok) throw new MiniAppStageError(safeErrorCode(body), response.status);
  if (body.ok !== true || typeof body.expiresAt !== "string") {
    throw new MiniAppStageError("invalid_response", response.status);
  }
}

export async function getMiniAppProfileSnapshot(
  initData: string,
  fetchFn: FetchLike = fetch,
): Promise<MiniAppProfileSnapshot> {
  await ensureOwnerSession(initData, fetchFn);
  const response = await sameOriginRequest("/api/mini-app/profile", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({}),
  }, fetchFn);
  const body = await responseBody(response);
  if (!response.ok) throw new MiniAppStageError(safeErrorCode(body), response.status);
  if (body.mode !== "read_only" || !body.snapshot || typeof body.snapshot !== "object" ||
      Array.isArray(body.snapshot)) {
    throw new MiniAppStageError("invalid_response", response.status);
  }
  return body.snapshot as MiniAppProfileSnapshot;
}

export async function mutateMiniAppRecord(
  initData: string,
  mutation: MiniAppMutationInput,
  fetchFn: FetchLike = fetch,
): Promise<MiniAppMutationResponse> {
  await ensureOwnerSession(initData, fetchFn);
  const response = await sameOriginRequest("/api/mini-app/mutations", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(mutation),
  }, fetchFn);
  const body = await responseBody(response);
  if (!response.ok) throw new MiniAppStageError(safeErrorCode(body), response.status);
  if (body.ok !== true || body.action !== mutation.action) {
    throw new MiniAppStageError("invalid_response", response.status);
  }
  return body as MiniAppMutationResponse;
}

export async function sendMiniAppTextTurn(
  initData: string,
  message: string,
  fetchFn: FetchLike = fetch,
  mode: MiniAppTurnMode = "text",
  turnId = crypto.randomUUID(),
): Promise<{
  reply: string;
  kind: "eli_text" | "access_denied" | "voice" | "avatar";
  media?: { type: "audio"; mimeType: "audio/ogg"; data: string } | { type: "video"; url: string };
}> {
  await ensureOwnerSession(initData, fetchFn);
  const response = await sameOriginRequest("/api/mini-app/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ message, mode, turnId }),
  }, fetchFn, 270_000);
  const body = await responseBody(response);
  if (!response.ok) throw new MiniAppStageError(safeErrorCode(body), response.status);
  if (typeof body.reply !== "string" ||
      !["eli_text", "access_denied", "voice", "avatar"].includes(String(body.kind))) {
    throw new MiniAppStageError("invalid_response", response.status);
  }
  let media: { type: "audio"; mimeType: "audio/ogg"; data: string } | { type: "video"; url: string } | undefined;
  if (body.media !== undefined) {
    if (!body.media || typeof body.media !== "object" || Array.isArray(body.media)) {
      throw new MiniAppStageError("invalid_response", response.status);
    }
    const value = body.media as Record<string, unknown>;
    if (value.type === "audio" && value.mimeType === "audio/ogg" && typeof value.data === "string" &&
        /^[A-Za-z0-9+/]+={0,2}$/.test(value.data)) {
      media = { type: "audio", mimeType: "audio/ogg", data: value.data };
    } else if (value.type === "video" && typeof value.url === "string") {
      try {
        if (new URL(value.url).protocol !== "https:") throw new Error();
      } catch {
        throw new MiniAppStageError("invalid_response", response.status);
      }
      media = { type: "video", url: value.url };
    } else {
      throw new MiniAppStageError("invalid_response", response.status);
    }
  }
  return {
    reply: body.reply,
    kind: body.kind as "eli_text" | "access_denied" | "voice" | "avatar",
    ...(media ? { media } : {}),
  };
}

export async function requestMiniAppCoaching(
  initData: string,
  action: MiniAppCoachingAction,
  fetchFn: FetchLike = fetch,
): Promise<MiniAppCoachingResult> {
  await ensureOwnerSession(initData, fetchFn);
  const response = await sameOriginRequest("/api/mini-app/coaching", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ action }),
  }, fetchFn, 270_000);
  const body = await responseBody(response);
  if (!response.ok) throw new MiniAppStageError(safeErrorCode(body), response.status);
  if (!["coaching", "no_data", "access_denied"].includes(String(body.kind)) ||
      typeof body.text !== "string") {
    throw new MiniAppStageError("invalid_response", response.status);
  }
  return { kind: body.kind as MiniAppCoachingResult["kind"], text: body.text };
}

export async function sendOwnerDemoChat(
  initData: string,
  message: string,
  language: MiniAppLanguage,
  fetchFn: FetchLike = fetch,
): Promise<{ reply: string; demo: true }> {
  await ensureOwnerSession(initData, fetchFn);
  const response = await sameOriginRequest("/api/mini-app/demo-chat", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ message, language }),
  }, fetchFn);
  const body = await responseBody(response);
  if (!response.ok) throw new MiniAppStageError(safeErrorCode(body), response.status);
  if (typeof body.reply !== "string" || body.demo !== true) {
    throw new MiniAppStageError("invalid_response", response.status);
  }
  return { reply: body.reply, demo: true };
}

export async function getOwnerTextAiStatus(
  initData: string,
  fetchFn: FetchLike = fetch,
): Promise<OwnerTextAiStatus> {
  await ensureOwnerSession(initData, fetchFn);
  const response = await sameOriginRequest("/api/mini-app/text-ai/status", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({}),
  }, fetchFn);
  const body = await responseBody(response);
  if (!response.ok) throw new MiniAppStageError(safeErrorCode(body), response.status);
  if (body.mode !== "mock" && body.mode !== "test_ai") {
    throw new MiniAppStageError("invalid_response", response.status);
  }
  if (typeof body.ownerDossierContext !== "boolean") {
    throw new MiniAppStageError("invalid_response", response.status);
  }
  return { mode: body.mode, ownerDossierContext: body.ownerDossierContext };
}

export async function sendOwnerTextAi(
  initData: string,
  message: string,
  language: MiniAppLanguage,
  fetchFn: FetchLike = fetch,
): Promise<OwnerTextAiResult> {
  await ensureOwnerSession(initData, fetchFn);
  const response = await sameOriginRequest("/api/mini-app/text-ai", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ message, language }),
  }, fetchFn, 28_000);
  const body = await responseBody(response);
  if (!response.ok) throw new MiniAppStageError(safeErrorCode(body), response.status);
  if (typeof body.reply !== "string") {
    throw new MiniAppStageError("invalid_response", response.status);
  }
  if (body.mode === "owner_dossier_faq") {
    return { reply: body.reply, mode: "owner_dossier_faq" };
  }
  if (body.mode !== "test_ai" || body.model !== "gpt-4o-mini") {
    throw new MiniAppStageError("invalid_response", response.status);
  }
  return {
    reply: body.reply,
    mode: "test_ai",
    model: "gpt-4o-mini",
  };
}

export async function uploadOwnerDemoMedia(
  initData: string,
  kind: "image" | "voice",
  file: File,
  language: MiniAppLanguage,
  caption = "",
  fetchFn: FetchLike = fetch,
): Promise<OwnerDemoMediaResult> {
  await ensureOwnerSession(initData, fetchFn);
  const form = new FormData();
  form.set("file", file, file.name || "attachment");
  form.set("language", language);
  if (kind === "image" && caption.trim()) form.set("caption", caption.trim().slice(0, 1200));
  const response = await sameOriginRequest(`/api/mini-app/media/${kind}`, {
    method: "POST",
    headers: { Accept: "application/json" },
    body: form,
  }, fetchFn, 70_000);
  const body = await responseBody(response);
  if (!response.ok) throw new MiniAppStageError(safeErrorCode(body), response.status);
  if (body.mediaType !== kind || body.staged !== true || body.demo !== true ||
      typeof body.reply !== "string" ||
      (kind === "voice" && typeof body.transcript !== "string")) {
    throw new MiniAppStageError("invalid_response", response.status);
  }
  return {
    reply: body.reply,
    staged: true,
    mediaType: kind,
    demo: true,
    ...(typeof body.transcript === "string" ? { transcript: body.transcript } : {}),
  };
}

export async function sendMiniAppVoiceTurn(
  initData: string,
  blob: Blob,
  fileName: string,
  language: MiniAppLanguage,
  mode: MiniAppTurnMode,
  prompt = "",
  fetchFn: FetchLike = fetch,
): Promise<MiniAppVoiceTurnResult> {
  await ensureOwnerSession(initData, fetchFn);
  const form = new FormData();
  form.set("file", new File([blob], fileName, { type: blob.type || "audio/webm" }));
  form.set("language", language);
  form.set("mode", mode);
  form.set("turnId", crypto.randomUUID());
  if (prompt.trim()) form.set("prompt", prompt.trim().slice(0, 1200));
  const response = await sameOriginRequest("/api/mini-app/media/voice", {
    method: "POST",
    headers: { Accept: "application/json" },
    body: form,
  }, fetchFn, 280_000);
  const body = await responseBody(response);
  if (!response.ok) throw new MiniAppStageError(safeErrorCode(body), response.status);
  let media: MiniAppVoiceTurnResult["media"];
  if (body.media !== undefined) {
    if (!body.media || typeof body.media !== "object" || Array.isArray(body.media)) {
      throw new MiniAppStageError("invalid_response", response.status);
    }
    const value = body.media as Record<string, unknown>;
    if (value.type === "audio" && value.mimeType === "audio/ogg" &&
        typeof value.data === "string" && value.data.length <= 8_000_000 &&
        /^[A-Za-z0-9+/]+={0,2}$/.test(value.data)) {
      media = { type: "audio", mimeType: "audio/ogg", data: value.data };
    } else if (value.type === "video" && typeof value.url === "string") {
      try {
        if (new URL(value.url).protocol !== "https:") throw new Error();
      } catch {
        throw new MiniAppStageError("invalid_response", response.status);
      }
      media = { type: "video", url: value.url };
    } else {
      throw new MiniAppStageError("invalid_response", response.status);
    }
  }
  if (typeof body.transcript !== "string" || typeof body.reply !== "string" ||
      !["eli_text", "voice", "avatar", "access_denied", "transcription_unclear"].includes(String(body.kind)) ||
      (media && !["audio", "video"].includes(media.type))) {
    throw new MiniAppStageError("invalid_response", response.status);
  }
  return {
    transcript: body.transcript,
    reply: body.reply,
    kind: body.kind as MiniAppVoiceTurnResult["kind"],
    ...(media ? { media } : {}),
  };
}
