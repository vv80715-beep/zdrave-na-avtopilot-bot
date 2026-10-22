export type MiniAppLanguage = "bg" | "en";

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

export async function uploadOwnerDemoMedia(
  initData: string,
  kind: "image" | "voice",
  file: File,
  language: MiniAppLanguage,
  caption = "",
  fetchFn: FetchLike = fetch,
): Promise<{ reply: string; transcript?: string; mediaType: "image" | "voice"; demo: true }> {
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
