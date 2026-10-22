import { useCallback, useEffect, useRef, useState } from "react";
import type { TranslationKey } from "./i18n";

export type ChatAttachment = {
  id: number;
  kind: "image" | "file" | "voice";
  blob: Blob;
  name: string;
  mimeType: string;
  size: number;
  url: string;
  supported: boolean;
};

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024;
const MAX_RECORDING_SECONDS = 90;
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const AUDIO_TYPES = new Set(["audio/ogg", "audio/webm", "audio/mp4", "audio/wav"]);
const RECORDING_MIMES = [
  "audio/webm;codecs=opus",
  "audio/ogg;codecs=opus",
  "audio/mp4",
  "audio/webm",
  "audio/ogg",
];

function normalizedMime(value: string) {
  return value.toLowerCase().split(";")[0].trim();
}

function recordingName(mimeType: string) {
  const mime = normalizedMime(mimeType);
  const extension = mime === "audio/ogg" ? "ogg" : mime === "audio/mp4" ? "m4a" : "webm";
  return `eli-recording.${extension}`;
}

export function useChatMedia() {
  const [attachment, setAttachment] = useState<ChatAttachment | null>(null);
  const [recording, setRecording] = useState<"idle" | "recording" | "processing" | "preview">("idle");
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [errorKey, setErrorKey] = useState<TranslationKey | null>(null);
  const urls = useRef(new Set<string>());
  const nextId = useRef(1);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const bytesRef = useRef(0);
  const startedAtRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const cancelRef = useRef(false);
  const sizeExceededRef = useRef(false);

  const releaseUrl = useCallback((url: string) => {
    if (urls.current.delete(url)) URL.revokeObjectURL(url);
  }, []);

  const makeAttachment = useCallback((blob: Blob, kind: ChatAttachment["kind"], name: string, mimeType: string, supported: boolean) => {
    const url = URL.createObjectURL(blob);
    urls.current.add(url);
    return {
      id: nextId.current++,
      kind,
      blob,
      name,
      mimeType: normalizedMime(mimeType),
      size: blob.size,
      url,
      supported,
    } satisfies ChatAttachment;
  }, []);

  const stopTracks = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  }, []);

  const clearTimer = useCallback(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = null;
  }, []);

  const discardAttachment = useCallback(() => {
    setAttachment((current) => {
      if (current) releaseUrl(current.url);
      return null;
    });
    setRecording("idle");
    setElapsedSeconds(0);
  }, [releaseUrl]);

  const selectFile = useCallback((file: File | undefined, expected: "image" | "file") => {
    setErrorKey(null);
    if (!file) return;
    if (attachment || recording !== "idle") {
      setErrorKey("oneAttachmentOnly");
      return;
    }
    const mime = normalizedMime(file.type);
    if (expected === "image" && !IMAGE_TYPES.has(mime)) {
      setErrorKey("attachmentTypeError");
      return;
    }
    const maxBytes = mime.startsWith("image/") ? MAX_IMAGE_BYTES : MAX_ATTACHMENT_BYTES;
    if (file.size > maxBytes) {
      setErrorKey(mime.startsWith("image/") ? "imageSizeError" : "fileSizeError");
      return;
    }
    const isPreviewImage = IMAGE_TYPES.has(mime);
    setAttachment(makeAttachment(file, isPreviewImage ? "image" : "file", file.name, mime, isPreviewImage || AUDIO_TYPES.has(mime)));
    setRecording("preview");
  }, [attachment, makeAttachment, recording]);

  const stopRecording = useCallback((cancel = false) => {
    const recorder = recorderRef.current;
    if (!recorder) return;
    cancelRef.current = cancel;
    clearTimer();
    stopTracks();
    if (recorder.state !== "inactive") {
      setRecording(cancel ? "idle" : "processing");
      recorder.stop();
    }
  }, [clearTimer, stopTracks]);

  const startRecording = useCallback(async () => {
    setErrorKey(null);
    if (attachment || recording !== "idle") {
      setErrorKey("oneAttachmentOnly");
      return;
    }
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setErrorKey("microphoneUnavailable");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const mimeType = RECORDING_MIMES.find((candidate) => MediaRecorder.isTypeSupported(candidate));
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      recorderRef.current = recorder;
      chunksRef.current = [];
      bytesRef.current = 0;
      cancelRef.current = false;
      sizeExceededRef.current = false;
      startedAtRef.current = performance.now();
      setElapsedSeconds(0);
      recorder.ondataavailable = (event) => {
        if (!event.data.size) return;
        bytesRef.current += event.data.size;
        if (bytesRef.current > MAX_ATTACHMENT_BYTES) {
          sizeExceededRef.current = true;
          setErrorKey("recordingSizeError");
          stopRecording(true);
          return;
        }
        chunksRef.current.push(event.data);
      };
      recorder.onerror = () => {
        setErrorKey("recordingFailed");
        stopRecording(true);
      };
      recorder.onstop = () => {
        recorderRef.current = null;
        stopTracks();
        if (cancelRef.current || sizeExceededRef.current) {
          chunksRef.current = [];
          setRecording("idle");
          setElapsedSeconds(0);
          return;
        }
        const type = normalizedMime(recorder.mimeType || mimeType || "audio/webm");
        const blob = new Blob(chunksRef.current, { type });
        chunksRef.current = [];
        if (!blob.size || blob.size > MAX_ATTACHMENT_BYTES || !AUDIO_TYPES.has(type)) {
          setErrorKey(blob.size > MAX_ATTACHMENT_BYTES ? "recordingSizeError" : "recordingFailed");
          setRecording("idle");
          setElapsedSeconds(0);
          return;
        }
        const audio = makeAttachment(blob, "voice", recordingName(type), type, true);
        setAttachment(audio);
        setRecording("preview");
      };
      recorder.start(1000);
      setRecording("recording");
      timerRef.current = setInterval(() => {
        const elapsed = Math.min(MAX_RECORDING_SECONDS, Math.floor((performance.now() - startedAtRef.current) / 1000));
        setElapsedSeconds(elapsed);
        if (elapsed >= MAX_RECORDING_SECONDS && recorderRef.current?.state === "recording") {
          setErrorKey("recordingDurationLimit");
          stopRecording(false);
        }
      }, 250);
    } catch (error) {
      stopTracks();
      setErrorKey(error instanceof DOMException && error.name === "NotAllowedError"
        ? "microphoneDenied"
        : "microphoneUnavailable");
    }
  }, [attachment, makeAttachment, recording, stopRecording, stopTracks]);

  useEffect(() => () => {
    clearTimer();
    if (recorderRef.current?.state !== "inactive") {
      cancelRef.current = true;
      recorderRef.current?.stop();
    }
    stopTracks();
    urls.current.forEach((url) => URL.revokeObjectURL(url));
    urls.current.clear();
  }, [clearTimer, stopTracks]);

  const detachForMessage = useCallback(() => {
    const current = attachment;
    if (!current) return null;
    setAttachment(null);
    setRecording("idle");
    setElapsedSeconds(0);
    return current;
  }, [attachment]);

  return {
    attachment,
    recording,
    elapsedSeconds,
    errorKey,
    selectFile,
    startRecording,
    stopRecording,
    discardAttachment,
    detachForMessage,
    clearError: () => setErrorKey(null),
    releaseUrl,
  };
}
