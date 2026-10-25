export type RecorderPort = {
  state: "inactive" | "recording" | "paused";
  mimeType: string;
  ondataavailable: ((event: { data: Blob }) => void) | null;
  onstop: (() => void) | null;
  onerror: (() => void) | null;
  start: (timeslice?: number) => void;
  stop: () => void;
};

export type RecorderStream = {
  getTracks: () => Array<{ stop: () => void }>;
};

export type RecorderConstructor = {
  new (stream: RecorderStream, options?: { mimeType?: string }): RecorderPort;
  isTypeSupported?: (mimeType: string) => boolean;
};

export type LocalRecordingSession = {
  recorder: RecorderPort;
  stop: (cancel?: boolean) => void;
  dispose: () => void;
};

export async function startLocalRecording(
  environment: {
    secureContext: boolean;
    getUserMedia?: (constraints: { audio: true }) => Promise<RecorderStream>;
    MediaRecorder?: RecorderConstructor;
  },
  mimeCandidates: string[],
  callbacks: {
    onData: (data: Blob) => void;
    onStop: (wasCancelled: boolean) => void;
    onError: () => void;
  },
): Promise<LocalRecordingSession> {
  if (!environment.secureContext || !environment.getUserMedia || !environment.MediaRecorder) {
    throw new Error("microphone_unavailable");
  }

  let stream: RecorderStream;
  try {
    stream = await environment.getUserMedia({ audio: true });
  } catch (error) {
    if (error instanceof DOMException && error.name === "NotAllowedError") {
      throw new Error("microphone_denied");
    }
    throw new Error("microphone_unavailable");
  }

  let recorder: RecorderPort;
  try {
    const mimeType = mimeCandidates.find((candidate) =>
      environment.MediaRecorder?.isTypeSupported?.(candidate) ?? false
    );
    recorder = new environment.MediaRecorder(stream, mimeType ? { mimeType } : undefined);
  } catch {
    stream.getTracks().forEach((track) => track.stop());
    throw new Error("microphone_unavailable");
  }

  let cancelRequested = false;
  let tracksStopped = false;
  const stopTracks = () => {
    if (tracksStopped) return;
    tracksStopped = true;
    stream.getTracks().forEach((track) => track.stop());
  };
  recorder.ondataavailable = (event) => {
    if (event.data.size) callbacks.onData(event.data);
  };
  recorder.onerror = () => {
    cancelRequested = true;
    callbacks.onError();
    if (recorder.state !== "inactive") recorder.stop();
    stopTracks();
  };
  recorder.onstop = () => {
    stopTracks();
    callbacks.onStop(cancelRequested);
  };

  try {
    recorder.start(1000);
  } catch {
    stopTracks();
    throw new Error("recording_failed");
  }

  return {
    recorder,
    stop(cancel = false) {
      cancelRequested ||= cancel;
      if (recorder.state !== "inactive") recorder.stop();
      stopTracks();
    },
    dispose() {
      cancelRequested = true;
      if (recorder.state !== "inactive") recorder.stop();
      stopTracks();
    },
  };
}
