import { readFile } from "node:fs/promises";

const OPENAI_CHAT_URL = "https://api.openai.com/v1/chat/completions";
const OPENAI_TRANSCRIPTION_URL = "https://api.openai.com/v1/audio/transcriptions";
const REQUEST_TIMEOUT_MS = 45_000;

export type MediaLanguage = "bg" | "en";

export type MediaAiProcessor = {
  analyzeImage(input: {
    path: string;
    mimeType: string;
    caption: string;
    language: MediaLanguage;
  }): Promise<{ reply: string }>;
  transcribeAndAnswer(input: {
    path: string;
    mimeType: string;
    language: MediaLanguage;
  }): Promise<{ transcript: string; reply: string }>;
};

type FetchLike = typeof fetch;

function languageInstructions(language: MediaLanguage) {
  return language === "en"
    ? {
        system: "You are Eli, a warm wellness coach. Describe only what is visible. Do not identify people, infer sensitive traits, diagnose, or invent details. If uncertain, say so. Give a concise, safe answer in English.",
        image: "Please describe the image and answer the user's question using only visible evidence.",
        voice: "Reply to the user's spoken message as Eli in concise, supportive English. Do not claim to have spoken aloud.",
      }
    : {
        system: "Ти си Ели — топъл wellness помощник. Описвай само видимото. Не идентифицирай хора, не извеждай чувствителни характеристики, не поставяй диагнози и не измисляй детайли. Ако не си сигурен, кажи го. Отговори кратко и безопасно на български.",
        image: "Опиши снимката и отговори на въпроса на потребителя само въз основа на видимото.",
        voice: "Отговори на изговореното съобщение като Ели — кратко и подкрепящо на български. Не твърди, че си отговорил с глас.",
      };
}

async function responseJson(response: Response): Promise<Record<string, unknown>> {
  if (!response.ok) throw new Error("provider_request_failed");
  try {
    const body = await response.json();
    if (!body || typeof body !== "object") throw new Error("invalid");
    return body as Record<string, unknown>;
  } catch {
    throw new Error("provider_invalid_response");
  }
}

function completionText(body: Record<string, unknown>): string {
  const choices = body.choices as Array<{ message?: { content?: unknown } }> | undefined;
  const content = choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) throw new Error("provider_empty_response");
  return content.trim();
}

export function createOpenAiMediaAiProcessor(
  apiKey: string,
  fetchFn: FetchLike = fetch,
): MediaAiProcessor {
  if (!apiKey.trim()) throw new Error("media_ai_not_configured");

  const headers = { Authorization: `Bearer ${apiKey}` };
  const timeout = () => AbortSignal.timeout(REQUEST_TIMEOUT_MS);

  async function answer(messages: unknown[]): Promise<string> {
    const response = await fetchFn(OPENAI_CHAT_URL, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gpt-4o-mini", messages, max_tokens: 400 }),
      signal: timeout(),
    });
    return completionText(await responseJson(response));
  }

  return {
    async analyzeImage({ path, mimeType, caption, language }) {
      const bytes = await readFile(path);
      const instructions = languageInstructions(language);
      const userText = [instructions.image, caption.trim()].filter(Boolean).join("\n\n");
      const reply = await answer([
        { role: "system", content: instructions.system },
        {
          role: "user",
          content: [
            { type: "text", text: userText },
            {
              type: "image_url",
              image_url: { url: `data:${mimeType};base64,${bytes.toString("base64")}` },
            },
          ],
        },
      ]);
      return { reply };
    },

    async transcribeAndAnswer({ path, mimeType, language }) {
      const audio = await readFile(path);
      const transcriptionForm = new FormData();
      transcriptionForm.set("file", new Blob([audio], { type: mimeType }), "eli-recording");
      transcriptionForm.set("model", "gpt-4o-transcribe");
      transcriptionForm.set("language", language);
      const transcriptionResponse = await fetchFn(OPENAI_TRANSCRIPTION_URL, {
        method: "POST",
        headers,
        body: transcriptionForm,
        signal: timeout(),
      });
      const transcription = await responseJson(transcriptionResponse);
      const transcript = typeof transcription.text === "string" ? transcription.text.trim() : "";
      if (!transcript) throw new Error("provider_empty_transcript");

      const instructions = languageInstructions(language);
      const reply = await answer([
        { role: "system", content: instructions.system },
        { role: "user", content: `${instructions.voice}\n\n${transcript}` },
      ]);
      return { transcript, reply };
    },
  };
}
