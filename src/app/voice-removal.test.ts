import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Voice recording and transcription are removed (ticket #10). The pipeline used
// to span the composer, the settings window, a microphone capture hook and a
// transcription request client, so these guards scan the shipped source instead
// of one surface: a retained module must not import the deleted voice modules,
// expose a capture/transcription path, or advertise a microphone capability.

const SRC = fileURLToPath(new URL("..", import.meta.url));
const TAURI = path.resolve(SRC, "../src-tauri");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walk(full));
    } else if (
      /\.tsx?$/.test(entry.name) &&
      !/\.test\.tsx?$/.test(entry.name)
    ) {
      out.push(full);
    }
  }
  return out;
}

function sourceHits(needle: RegExp): string[] {
  const hits: string[] = [];
  for (const file of walk(SRC)) {
    const text = readFileSync(file, "utf8");
    if (needle.test(text)) hits.push(path.relative(SRC, file));
  }
  return hits;
}

describe("voice recording and transcription removal", () => {
  it("no retained module imports the deleted voice modules", () => {
    expect(sourceHits(/\buseWhisperRecording\b/)).toEqual([]);
    expect(sourceHits(/from\s+"(?:[^"]*\/)?lib\/stt"/)).toEqual([]);
    expect(sourceHits(/from\s+"(?:[^"]*\/)?stt"/)).toEqual([]);
  });

  it("exposes no microphone capture, recording or transcription request path", () => {
    // Capture, recording and upload endpoints are the concrete paths a user
    // could reach a recording/transcription flow through. `AudioContext` is not
    // listed: it is shared with retained media previews.
    expect(sourceHits(/getUserMedia/)).toEqual([]);
    expect(sourceHits(/\bMediaRecorder\b/)).toEqual([]);
    expect(sourceHits(/transcribeAudio|experimental_transcribe/)).toEqual([]);
    expect(sourceHits(/audio\/transcriptions/)).toEqual([]);
    expect(sourceHits(/sttProvider|groqSttModel|whispercppBaseURL/)).toEqual(
      [],
    );
    expect(sourceHits(/STT_PROVIDER_LABELS|SttProvider/)).toEqual([]);
  });

  it("grants no microphone or media-capture capability to a window", () => {
    const granted: string[] = [];
    for (const entry of readdirSync(path.join(TAURI, "capabilities"))) {
      if (!entry.endsWith(".json")) continue;
      const capability = JSON.parse(
        readFileSync(path.join(TAURI, "capabilities", entry), "utf8"),
      ) as { permissions?: unknown[] };
      for (const permission of capability.permissions ?? []) {
        if (
          typeof permission === "string" &&
          /media|audio|microphone|mic:/i.test(permission)
        ) {
          granted.push(`${entry}: ${permission}`);
        }
      }
    }
    expect(granted).toEqual([]);
  });
});
