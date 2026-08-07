import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Talking to the assistant, and being talked back to.
 *
 * Claude's own voice mode is not reachable from here: the CLI and the API take
 * text and images, never audio, so a spoken question has to become text before
 * it can be asked at all. This records it and the pod transcribes it.
 *
 * Recording rather than the browser's SpeechRecognition on purpose. Recognition
 * exists in two browsers, is unreliable on iOS, and ships the audio to Google or
 * Apple to be understood — so it is both less portable and no more private than
 * doing it ourselves. getUserMedia and MediaRecorder are everywhere.
 *
 * Speaking back is still the browser's, because speechSynthesis is universal,
 * free, and needs nothing on the pod.
 */

/**
 * How the end of a sentence is detected without a button: the level drops and
 * stays down. Hands-free is the whole point, so something has to decide when
 * you have stopped talking, and a pause is the only signal there is.
 */
const SILENCE_RMS = 0.012;
const SILENCE_MS = 1400;
const MAX_CLIP_MS = 30_000;

/**
 * Recording needs a microphone and MediaRecorder, both of which are everywhere;
 * this is a feature test rather than a browser test on purpose.
 */
export const canListen = (): boolean =>
  typeof navigator !== "undefined" &&
  !!navigator.mediaDevices?.getUserMedia &&
  typeof MediaRecorder !== "undefined";

export const canSpeak = (): boolean => typeof window !== "undefined" && "speechSynthesis" in window;

/**
 * What to read out of a reply. Spoken text is not written text: backticks,
 * asterisks and a session id read aloud character by character are noise, and a
 * long answer read to the end is worse than one cut short — you can always look
 * at the screen.
 */
/**
 * Picking a voice, because the browser's default is whatever it found first and
 * usually the worst thing installed. The good ones are not named consistently
 * across platforms, so this ranks on the words vendors actually use for their
 * better engines, and falls back to any voice in the page's language.
 *
 * Chrome's Google voices are network-synthesised and much better than its local
 * ones; macOS and iOS ship Siri and premium voices that are better again. Hence
 * the order.
 */
const VOICE_RANK = [/siri/i, /premium|enhanced|neural/i, /^google /i, /natural/i];

export function pickVoice(
  voices: SpeechSynthesisVoice[],
  preferred?: string,
): SpeechSynthesisVoice | null {
  if (!voices.length) return null;
  if (preferred) {
    const chosen = voices.find((v) => v.name === preferred);
    if (chosen) return chosen;
  }
  const lang = (typeof navigator !== "undefined" ? navigator.language : "en") || "en";
  const base = lang.split("-")[0];
  const sameLanguage = voices.filter((v) => v.lang?.toLowerCase().startsWith(base.toLowerCase()));
  const pool = sameLanguage.length ? sameLanguage : voices;
  for (const pattern of VOICE_RANK) {
    const hit = pool.find((v) => pattern.test(v.name));
    if (hit) return hit;
  }
  // Nothing recognisable: a remote voice still beats a local one on Chrome.
  return pool.find((v) => !v.localService) ?? pool[0];
}

/** Voices load asynchronously, and are an empty list until they do. */
export function useVoices(): SpeechSynthesisVoice[] {
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  useEffect(() => {
    if (!canSpeak()) return;
    const load = () => setVoices(speechSynthesis.getVoices());
    load();
    speechSynthesis.addEventListener("voiceschanged", load);
    return () => speechSynthesis.removeEventListener("voiceschanged", load);
  }, []);
  return voices;
}

/** The chosen voice is per device: what is installed differs on each one. */
export const VOICE_KEY = "vk.assistant.voice";

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
  const [transcribing, setTranscribing] = useState(false);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const stopRef = useRef<(() => void) | null>(null);
  // Held in a ref so restarting the microphone after a reply does not depend on
  // the callback identity being stable across renders.
  const onFinalRef = useRef(onFinal);
  onFinalRef.current = onFinal;

  const stopListening = useCallback(() => {
    stopRef.current?.();
  }, []);

  /**
   * Record until the room goes quiet, then hand the clip to the pod.
   *
   * The analyser runs off the same stream the recorder does, so the level being
   * watched is the audio being kept — no second microphone, and no chance of
   * stopping on silence that was never recorded.
   */
  const listen = useCallback(async () => {
    if (!canListen()) return;
    stopRef.current?.();
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      // Refused, or no microphone. Nothing to recover: the button stays off.
      setListening(false);
      return;
    }

    const chunks: Blob[] = [];
    const recorder = new MediaRecorder(stream);
    const context = new AudioContext();
    const analyser = context.createAnalyser();
    analyser.fftSize = 1024;
    context.createMediaStreamSource(stream).connect(analyser);
    const samples = new Float32Array(analyser.fftSize);

    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearInterval(timer);
      clearTimeout(cap);
      if (recorder.state !== "inactive") recorder.stop();
    };
    stopRef.current = () => {
      cancelled = true;
      finish();
    };
    let cancelled = false;

    let quietFor = 0;
    let heardAnything = false;
    const timer = setInterval(() => {
      analyser.getFloatTimeDomainData(samples);
      let sum = 0;
      for (const v of samples) sum += v * v;
      const rms = Math.sqrt(sum / samples.length);
      if (rms > SILENCE_RMS) {
        heardAnything = true;
        quietFor = 0;
      } else {
        quietFor += 100;
        // Only after something was actually said: otherwise it gives up
        // instantly on someone who has not started yet.
        if (heardAnything && quietFor >= SILENCE_MS) finish();
      }
    }, 100);
    // A recorder left running because the level never dropped is a microphone
    // left open indefinitely.
    const cap = setTimeout(finish, MAX_CLIP_MS);

    recorder.ondataavailable = (e) => {
      if (e.data.size) chunks.push(e.data);
    };
    recorder.onstop = () => {
      for (const track of stream.getTracks()) track.stop();
      void context.close();
      setListening(false);
      recorderRef.current = null;
      stopRef.current = null;
      if (cancelled || !heardAnything || !chunks.length) return;
      const clip = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
      setTranscribing(true);
      void fetch("/api/assistant/transcribe", {
        method: "POST",
        headers: { "content-type": clip.type },
        body: clip,
      })
        .then(async (res) => {
          if (!res.ok) return;
          const { text } = (await res.json()) as { text: string };
          if (text) onFinalRef.current(text);
        })
        .catch(() => {
          // A failed transcription is silence as far as the caller is concerned.
        })
        .finally(() => setTranscribing(false));
    };

    recorder.start();
    recorderRef.current = recorder;
    setListening(true);
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
    const voice = pickVoice(
      speechSynthesis.getVoices(),
      localStorage.getItem(VOICE_KEY) ?? undefined,
    );
    if (voice) {
      utterance.voice = voice;
      // Matching the voice's own language stops a British voice reading text
      // tagged en-US in a flattened accent.
      utterance.lang = voice.lang;
    }
    // Slightly quick: this is a status update, not an audiobook.
    utterance.rate = 1.08;
    utterance.pitch = 1;
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
      stopRef.current?.();
      if (canSpeak()) speechSynthesis.cancel();
    };
  }, []);

  return { listening, speaking, transcribing, listen, stopListening, speak, cancelSpeech };
}
