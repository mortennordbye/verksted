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

/**
 * Break a reply into the pieces the pod synthesises one at a time.
 *
 * The pod makes audio at roughly a third of real time, so a whole answer in one
 * request is several seconds of silence before anything is heard. A sentence is
 * the natural unit: the first one starts playing while the rest are still being
 * made, and the seam falls where a speaker would pause anyway.
 *
 * Short sentences are merged — "Done." on its own costs a round trip to say one
 * word — and anything longer than the endpoint accepts is split on a space
 * rather than truncated.
 */
/**
 * The first chunk is the whole of the wait before anything is heard, so it is
 * deliberately smaller than the ones after it — those are made while their
 * predecessor is playing, where a few hundred milliseconds cost nothing.
 */
const FIRST_TARGET = 90;
const CHUNK_TARGET = 180;
const CHUNK_MAX = 800;

export function chunkForSpeech(text: string): string[] {
  const sentences = text.match(/[^.!?]+[.!?]*\s*/g) ?? (text ? [text] : []);
  const chunks: string[] = [];
  let current = "";
  for (const raw of sentences) {
    let sentence = raw.trim();
    if (!sentence) continue;
    while (sentence.length > CHUNK_MAX) {
      const cut = sentence.lastIndexOf(" ", CHUNK_MAX);
      chunks.push(sentence.slice(0, cut > 0 ? cut : CHUNK_MAX).trim());
      sentence = sentence.slice(cut > 0 ? cut : CHUNK_MAX).trim();
    }
    const target = chunks.length === 0 ? FIRST_TARGET : CHUNK_TARGET;
    if (!current) current = sentence;
    else if (current.length + sentence.length + 1 <= target) current += " " + sentence;
    else {
      chunks.push(current);
      current = sentence;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

/** The voice the pod should use, chosen on the settings panel. */
export const POD_VOICE_KEY = "vk.assistant.podVoice";

/**
 * Kokoro names its voices `<language><gender>_<name>`: `bf_emma` is a British
 * woman called Emma. Fifty-four of those in a dropdown is a puzzle, so this
 * spells them out.
 */
const VOICE_LANGS: Record<string, string> = {
  a: "American",
  b: "British",
  e: "Spanish",
  f: "French",
  h: "Hindi",
  i: "Italian",
  j: "Japanese",
  p: "Portuguese",
  z: "Chinese",
};

export function voiceLabel(id: string): string {
  const m = /^([a-z])([fm])_(.+)$/.exec(id);
  if (!m) return id;
  const name = m[3].charAt(0).toUpperCase() + m[3].slice(1);
  const lang = VOICE_LANGS[m[1]];
  const gender = m[2] === "f" ? "female" : "male";
  return lang ? `${name} · ${lang} ${gender}` : `${name} · ${gender}`;
}

/** English first: it is what the assistant answers in. */
export function sortVoices(ids: string[]): string[] {
  return [...ids].sort((a, b) => {
    const english = (v: string) => (v.startsWith("a") || v.startsWith("b") ? 0 : 1);
    return english(a) - english(b) || a.localeCompare(b);
  });
}

/**
 * One audio element for the life of the page, because of iOS.
 *
 * Safari only lets audio play if the element was started inside a user gesture
 * at least once. Playing a reply arrives later than any gesture, so the element
 * is unlocked on the tap that turns speech on — with a silent clip, which is
 * the standard trick — and reused from then on.
 */
let player: HTMLAudioElement | null = null;
const SILENCE =
  "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAgD4AAAB9AAACABAAZGF0YQAAAAA=";

export function audioPlayer(): HTMLAudioElement {
  player ??= new Audio();
  return player;
}

/** Call from inside a user gesture, once, so later replies can be played. */
export function unlockAudio(): void {
  const audio = audioPlayer();
  audio.src = SILENCE;
  void audio.play().catch(() => {
    // Refused: the pod voice will not play on this device, and speak() falls
    // back to speechSynthesis, which has the same rule and the same unlock.
  });
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

  // Bumped to abandon whatever is being said: a reply arriving mid-sentence, or
  // the screen going away. Everything asynchronous below checks it before it
  // touches the player again.
  const runRef = useRef(0);

  const cancelSpeech = useCallback(() => {
    runRef.current++;
    if (canSpeak()) speechSynthesis.cancel();
    const audio = audioPlayer();
    audio.pause();
    setSpeaking(false);
  }, []);

  /**
   * Say it in the pod's voice, a sentence at a time.
   *
   * Each chunk is fetched while the previous one plays, so the gap between
   * sentences is synthesis that already happened. Returns false only when the
   * *first* chunk could not be had — that is the "this pod has no voice" case,
   * and the caller falls back to the browser. A failure later in a reply is not
   * worth restarting the whole thing in a different voice halfway through.
   */
  const speakOnPod = useCallback(
    async (body: string, run: number, asVoice?: string): Promise<boolean> => {
      // The speaker's own voice wins over the device's default: a council read
      // aloud in one voice is four answers that sound like one person changing
      // their mind, which is the thing having several of them is meant to fix.
      const voice = asVoice || localStorage.getItem(POD_VOICE_KEY) || undefined;
      const chunks = chunkForSpeech(body);
      if (!chunks.length) return false;
      const audio = audioPlayer();

      const clip = async (text: string): Promise<string | null> => {
        try {
          const res = await fetch("/api/assistant/speak", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(voice ? { text, voice } : { text }),
          });
          // 503 is "no voice on this pod", which is an answer, not a failure.
          if (!res.ok) return null;
          return URL.createObjectURL(await res.blob());
        } catch {
          return null;
        }
      };

      let next = clip(chunks[0]);
      for (let i = 0; i < chunks.length; i++) {
        const url = await next;
        if (runRef.current !== run) {
          if (url) URL.revokeObjectURL(url);
          return true;
        }
        if (!url) return i > 0;
        next = i + 1 < chunks.length ? clip(chunks[i + 1]) : Promise.resolve(null);
        try {
          await new Promise<void>((resolve, reject) => {
            audio.onended = () => resolve();
            audio.onerror = () => reject(new Error("playback failed"));
            audio.src = url;
            void audio.play().catch(reject);
          });
        } catch {
          // Autoplay refused, or a clip the device would not play: the browser's
          // own voice has a better chance than the next chunk does.
          URL.revokeObjectURL(url);
          return i > 0;
        } finally {
          audio.onended = null;
          audio.onerror = null;
        }
        URL.revokeObjectURL(url);
        if (runRef.current !== run) return true;
      }
      return true;
    },
    [],
  );

  const speakInBrowser = useCallback((body: string, onDone?: () => void) => {
    if (!canSpeak()) {
      setSpeaking(false);
      return onDone?.();
    }
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

  /**
   * Read something out: the pod's voice if it has one, the browser's if not.
   *
   * The order is not a preference, it is the whole point — the browser voice is
   * what made this sound like a machine, and on iOS it is the worst of them,
   * because Safari keeps Siri and the enhanced voices to itself.
   */
  const speak = useCallback(
    (text: string, onDone?: () => void, asVoice?: string) => {
      const body = speakable(text);
      if (!body) return onDone?.();
      const run = ++runRef.current;
      if (canSpeak()) speechSynthesis.cancel();
      audioPlayer().pause();
      setSpeaking(true);
      void speakOnPod(body, run, asVoice).then((spoken) => {
        if (runRef.current !== run) return;
        if (spoken) {
          setSpeaking(false);
          onDone?.();
        } else {
          speakInBrowser(body, onDone);
        }
      });
    },
    [speakOnPod, speakInBrowser],
  );

  // A page left mid-sentence keeps talking otherwise: speechSynthesis and the
  // audio element both belong to the tab, not to this component.
  useEffect(() => {
    return () => {
      runRef.current++;
      stopRef.current?.();
      if (canSpeak()) speechSynthesis.cancel();
      audioPlayer().pause();
    };
  }, []);

  return { listening, speaking, transcribing, listen, stopListening, speak, cancelSpeech };
}
