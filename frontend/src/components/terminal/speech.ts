/**
 * The browser's dictation engine. The pod has no microphone and never will —
 * the phone in your hand does — so speech becomes text here and reaches the
 * agent as ordinary typing. Safari and Chrome both still expose it under the
 * webkit prefix. Needs a secure origin, same as push.
 */
export interface Recognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start: () => void;
  stop: () => void;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onerror: (() => void) | null;
  onend: (() => void) | null;
}

export function speechCtor(): (new () => Recognition) | null {
  const w = window as unknown as {
    SpeechRecognition?: new () => Recognition;
    webkitSpeechRecognition?: new () => Recognition;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}
