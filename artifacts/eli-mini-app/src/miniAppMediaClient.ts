export type MiniAppMediaKind = "image" | "voice";

export type MiniAppMediaResult =
  | { mediaType: "image"; reply: string; staged: true; demo: true }
  | { mediaType: "voice"; transcript: string; reply: string; staged: true; demo: true };

import { uploadOwnerDemoMedia } from "./miniAppSessionClient";

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
  return uploadOwnerDemoMedia(initData, kind, file, language, caption, fetchFn);
}
