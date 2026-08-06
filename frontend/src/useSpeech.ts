import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Talking to the assistant, and being talked back to.
 *
 * Both halves are the browser's own: SpeechRecognition for what you say,
 * speechSynthesis for what it answers. Claude's own voice mode is not reachable
 * from here — the CLI and the API take text and images, not audio — so a voice
 * conversation has to be assembled on this side of the wire. The upside is that
 * it costs nothing and needs no backend; the downside is that recognition is
 * only present in some browsers, which is why everything here is feature-tested
 * rather than assumed.
 */

interface SpeechAlternative {
  transcript: string;
}
interface SpeechResult {
  0: SpeechAlternative;
  isFinal: boolean;
}
export interface SpeechEvent {
  results: { [i: number]: SpeechResult; length: number };
}
export interface SpeechRecognitionLike {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: (e: SpeechEvent) => void;
  onend: () => void;
  onerror: () => void;
  start: () => void;
  stop: () => void;
  abort: () => void;
}

function recogniser(): (new () => SpeechRecognitionLike) | undefined {
  if (typeof window === "undefined") return undefined;
  const w = window as unknown as {
    SpeechRecognition?: new () => SpeechRecognitionLike;
    webkitSpeechRecognition?: new () => SpeechRecognitionLike;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition;
}

export const canListen = (): boolean => recogniser() !== undefined;
export const canSpeak = (): boolean => typeof window !== "undefined" && "speechSynthesis" in window;

/**
 * What to read out of a reply. Spoken text is not written text: backticks,
 * asterisks and a session id read aloud character by character are noise, and a
 * long answer read to the end is worse than one cut short — you can always look
 * at the screen.
 */
export function speakable(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " code block ")
    .replace(/[`*_#>]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 700);
}

export function useSpeech(onFinal: (said: string) => void) {
  const [listening, setListening] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  // Held in a ref so restarting the microphone after a reply does not depend on
  // the callback identity being stable across renders.
  const onFinalRef = useRef(onFinal);
  onFinalRef.current = onFinal;

  const stopListening = useCallback(() => {
    recognitionRef.current?.abort();
    recognitionRef.current = null;
    setListening(false);
  }, []);

  /**
   * Listen until you stop talking, then hand over what was said.
   *
   * continuous is off on purpose: the pause at the end of a sentence is the
   * only "I am done" signal available without a button, and hands-free is the
   * whole point of the mode this serves.
   */
  const listen = useCallback((onInterim?: (said: string) => void) => {
    const Recognition = recogniser();
    if (!Recognition) return;
    recognitionRef.current?.abort();
    const recognition = new Recognition();
    recognition.lang = navigator.language || "en-US";
    recognition.interimResults = true;
    recognition.continuous = false;
    let final = "";
    recognition.onresult = (e: SpeechEvent) => {
      let said = "";
      for (let i = 0; i < e.results.length; i++) said += e.results[i][0].transcript;
      final = said;
      onInterim?.(said);
    };
    recognition.onend = () => {
      setListening(false);
      recognitionRef.current = null;
      const said = final.trim();
      if (said) onFinalRef.current(said);
    };
    recognition.onerror = () => {
      setListening(false);
      recognitionRef.current = null;
    };
    recognition.start();
    setListening(true);
    recognitionRef.current = recognition;
  }, []);

  const cancelSpeech = useCallback(() => {
    if (canSpeak()) speechSynthesis.cancel();
    setSpeaking(false);
  }, []);

  const speak = useCallback((text: string, onDone?: () => void) => {
    if (!canSpeak()) return onDone?.();
    const body = speakable(text);
    if (!body) return onDone?.();
    speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(body);
    utterance.rate = 1.05;
    utterance.onend = () => {
      setSpeaking(false);
      onDone?.();
    };
    utterance.onerror = () => {
      setSpeaking(false);
      onDone?.();
    };
    setSpeaking(true);
    speechSynthesis.speak(utterance);
  }, []);

  // A page left mid-sentence keeps talking otherwise: speechSynthesis belongs to
  // the tab, not to this component.
  useEffect(() => {
    return () => {
      recognitionRef.current?.abort();
      if (canSpeak()) speechSynthesis.cancel();
    };
  }, []);

  return { listening, speaking, listen, stopListening, speak, cancelSpeech };
}
