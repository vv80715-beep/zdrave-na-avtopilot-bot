import assert from "node:assert/strict";
import test from "node:test";
import { startLocalRecording } from "../src/localRecorder.ts";

class MockRecorder {
  static instance;
  static isTypeSupported(type) {
    return type === "audio/webm";
  }
  state = "inactive";
  mimeType;
  ondataavailable = null;
  onstop = null;
  onerror = null;

  constructor(stream, options) {
    this.stream = stream;
    this.mimeType = options?.mimeType || "audio/webm";
    MockRecorder.instance = this;
  }
  start(timeslice) {
    assert.equal(timeslice, 1000);
    this.state = "recording";
  }
  stop() {
    this.state = "inactive";
    this.ondataavailable?.({ data: new Blob(["final audio"], { type: this.mimeType }) });
    this.onstop?.();
  }
  emit(data) {
    this.ondataavailable?.({ data });
  }
}

function environment() {
  let stoppedTracks = 0;
  let constraints;
  const stream = {
    getTracks: () => [{ stop: () => { stoppedTracks += 1; } }],
  };
  return {
    value: {
      secureContext: true,
      getUserMedia: async (value) => { constraints = value; return stream; },
      MediaRecorder: MockRecorder,
    },
    get stoppedTracks() { return stoppedTracks; },
    get constraints() { return constraints; },
  };
}

test("recording starts with the selected supported MIME and stop preserves audio while releasing tracks", async () => {
  const env = environment();
  const received = [];
  const stopped = [];
  const session = await startLocalRecording(env.value, ["audio/ogg", "audio/webm"], {
    onData: (blob) => received.push(blob),
    onStop: (cancelled) => stopped.push(cancelled),
    onError: () => assert.fail("unexpected recorder error"),
  });
  assert.deepEqual(env.constraints, { audio: true });
  assert.equal(session.recorder.state, "recording");
  assert.equal(session.recorder.mimeType, "audio/webm");
  MockRecorder.instance.emit(new Blob(["first chunk"]));
  session.stop();
  assert.equal(session.recorder.state, "inactive");
  assert.deepEqual(stopped, [false]);
  assert.equal(received.length, 2);
  assert.equal(env.stoppedTracks, 1);
});

test("cancel and unmount disposal mark the recording cancelled and release tracks once", async () => {
  for (const action of ["cancel", "dispose"]) {
    const env = environment();
    const stopped = [];
    const session = await startLocalRecording(env.value, ["audio/webm"], {
      onData: () => {},
      onStop: (cancelled) => stopped.push(cancelled),
      onError: () => assert.fail("unexpected recorder error"),
    });
    if (action === "cancel") session.stop(true);
    else session.dispose();
    assert.deepEqual(stopped, [true]);
    assert.equal(env.stoppedTracks, 1);
  }
});

test("microphone permission failures and insecure contexts are rejected before recording", async () => {
  await assert.rejects(
    startLocalRecording({
      secureContext: false,
      getUserMedia: async () => { throw new Error("should not be called"); },
      MediaRecorder: MockRecorder,
    }, ["audio/webm"], { onData: () => {}, onStop: () => {}, onError: () => {} }),
    /microphone_unavailable/,
  );
  await assert.rejects(
    startLocalRecording({
      secureContext: true,
      getUserMedia: async () => { throw new DOMException("denied", "NotAllowedError"); },
      MediaRecorder: MockRecorder,
    }, ["audio/webm"], { onData: () => {}, onStop: () => {}, onError: () => {} }),
    /microphone_denied/,
  );
});
