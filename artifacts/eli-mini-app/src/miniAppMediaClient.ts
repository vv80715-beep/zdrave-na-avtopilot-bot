export type MiniAppMediaKind = "image" | "voice";

export type MiniAppMediaResult =
  | { mediaType: "image"; reply: string; staged: true }
  | { mediaType: "voice"; transcript: string; reply: string; staged: true };

/**
 * Explicit future owner-canary helper. The chat demo does not call this.
 * It obtains a server-verified owner session first and never uploads media if
 * Telegram initData is missing or the staging session endpoint is unavailable.
 */
export async function uploadOwnerMediaWithInitData(
  kind: MiniAppMediaKind,
  file: File,
  initData: string,
  language: "bg" | "en",
  caption = "",
  fetchFn: typeof fetch = fetch,
): Promise<MiniAppMediaResult> {
  if (typeof window === "undefined" || !window.isSecureContext) {
    throw new Error("secure_context_required");
  }
  if (!initData.trim()) throw new Error("telegram_auth_required");
  const session = await fetchFn("/api/mini-app/session", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ initData }),
  });
  if (!session.ok) throw new Error("owner_staging_session_unavailable");

  const form = new FormData();
  form.set("file", file, file.name || "attachment");
  form.set("language", language);
  if (kind === "image" && caption) form.set("caption", caption);
  const response = await fetchFn(`/api/mini-app/media/${kind}`, {
    method: "POST",
    credentials: "include",
    body: form,
  });
  if (!response.ok) throw new Error("owner_staging_media_unavailable");
  return await response.json() as MiniAppMediaResult;
}
