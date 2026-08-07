import { describe, expect, it } from "vitest";
import { cleanTranscript } from "../src/transcribe.js";

/**
 * Whisper narrates what it hears, including when it hears nothing. Any of that
 * reaching the assistant as though it were a question means an answer to
 * silence, so this is the filter that decides whether a clip counts as speech.
 */
describe("cleanTranscript", () => {
  it("keeps what was actually said", () => {
    expect(cleanTranscript(" What needs me today?\n")).toBe("What needs me today?");
  });

  it("joins the lines a long clip is broken into", () => {
    expect(cleanTranscript("Start a session in Homelab\nand commit what is pending.")).toBe(
      "Start a session in Homelab and commit what is pending.",
    );
  });

  it("drops the timestamps whisper prefixes when it feels like it", () => {
    expect(cleanTranscript("[00:00:00.000 --> 00:00:02.000]  Merge the renovate PRs.")).toBe(
      "Merge the renovate PRs.",
    );
  });

  it("treats an empty clip as nothing said, not as a question", () => {
    expect(cleanTranscript("[BLANK_AUDIO]")).toBe("");
    expect(cleanTranscript("(silence)")).toBe("");
    // Whisper picks its own word for a noise, so the rule has to be structural
    // rather than a list: a real tone came back as "(beep)".
    expect(cleanTranscript("(beep)")).toBe("");
    expect(cleanTranscript("[ Silence ]")).toBe("");
    expect(cleanTranscript("  \n  ")).toBe("");
    // Whisper hears punctuation in room tone; a lone "." is not a question.
    expect(cleanTranscript(". . .")).toBe("");
  });

  it("keeps speech that happens to sit next to a noise marker", () => {
    expect(cleanTranscript("[MUSIC] what is running right now?")).toBe(
      "what is running right now?",
    );
  });
});
