import { useEffect, useState } from "react";
import type { AssistantConfig, AssistantTool, AssistantVoices } from "../../../shared/api";
import { api, usePoll } from "../api";
import {
  POD_VOICE_KEY,
  VOICE_KEY,
  audioPlayer,
  canSpeak,
  pickVoice,
  sortVoices,
  useVoices,
  voiceLabel,
} from "../useSpeech";

/**
 * Who the assistant is, and what it costs to run.
 *
 * The model is free text rather than a dropdown: aliases come and go, and a
 * settings page that cannot name a new one is worse than one that lets a typo
 * through and says so on the next turn.
 */
const EFFORTS: AssistantConfig["effort"][] = ["low", "medium", "high", "xhigh", "max"];

/**
 * What it can do, listed here so it never has to say so in a reply.
 *
 * Read from its own tool server rather than written here, so the page cannot
 * drift from what the model is actually offered. Folded by default: it is the
 * answer to a question asked once, not something to scroll past every visit.
 */
function CanDo() {
  const [tools, setTools] = useState<AssistantTool[] | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open || tools) return;
    void api<AssistantTool[]>("/api/assistant/tools")
      .then(setTools)
      .catch(() => setTools([]));
  }, [open, tools]);
  return (
    <div className="mt-3 rounded-[11px] border border-line bg-surface px-[15px] py-3">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 text-left text-[13.5px] font-medium hover:text-text"
      >
        <span className="font-mono text-[11px] text-faint">{open ? "▾" : "▸"}</span>
        What it can do
        <span className="ml-auto font-mono text-[11px] text-faint">
          read the bench, the repos, the cluster and the web; act through these
        </span>
      </button>
      {open && (
        <div className="mt-3 flex flex-col gap-2">
          {tools === null && <div className="text-sm text-muted">asking…</div>}
          {tools?.length === 0 && (
            <div className="text-sm text-muted">its tool server did not answer</div>
          )}
          {tools?.map((t) => (
            <div
              key={t.name}
              className="flex flex-col gap-0.5 min-[620px]:flex-row min-[620px]:gap-3"
            >
              <code className="flex-none font-mono text-[12px] text-accent min-[620px]:w-[150px]">
                {t.name}
              </code>
              <span className="text-[13px] text-muted">{t.description}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function AssistantPanel() {
  const { data } = usePoll<AssistantConfig>("/api/assistant/config", 60_000);
  const [draft, setDraft] = useState<AssistantConfig | null>(null);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Adopt the server's answer once, then leave the fields alone: a poll landing
  // mid-sentence must not overwrite what is being typed.
  useEffect(() => {
    setDraft((d) => d ?? data);
  }, [data]);

  async function save() {
    if (!draft) return;
    setError(null);
    try {
      setDraft(
        await api<AssistantConfig>("/api/assistant/config", {
          method: "PUT",
          body: JSON.stringify(draft),
        }),
      );
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const voices = useVoices();
  const [voiceName, setVoiceName] = useState(() => localStorage.getItem(VOICE_KEY) ?? "");
  const [podVoices, setPodVoices] = useState<string[]>([]);
  const [defaultVoice, setDefaultVoice] = useState("");
  const [podVoice, setPodVoice] = useState(() => localStorage.getItem(POD_VOICE_KEY) ?? "");
  const [sampling, setSampling] = useState(false);

  useEffect(() => {
    void api<AssistantVoices>("/api/assistant/voices")
      .then((v) => {
        setPodVoices(v.voices);
        setDefaultVoice(v.current);
      })
      .catch(() => {
        // No voice on this pod, or it could not be reached: the browser list
        // below is the answer either way.
      });
  }, []);

  /**
   * Which voice the pod speaks in, per device — the same reason the browser one
   * is: two people at two screens can disagree about it without either being
   * wrong, and it is one string.
   */
  async function choosePodVoice(name: string) {
    setPodVoice(name);
    if (name) localStorage.setItem(POD_VOICE_KEY, name);
    else localStorage.removeItem(POD_VOICE_KEY);
    setSampling(true);
    try {
      const res = await fetch("/api/assistant/speak", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          text: "Nothing needs you. Everything is quiet.",
          ...(name ? { voice: name } : {}),
        }),
      });
      if (!res.ok) return;
      const url = URL.createObjectURL(await res.blob());
      const audio = audioPlayer();
      audio.src = url;
      // This is a click, so playing here also unlocks the element for the
      // replies that arrive later without one.
      await audio.play().catch(() => undefined);
      audio.onended = () => URL.revokeObjectURL(url);
    } finally {
      setSampling(false);
    }
  }

  /**
   * Stored per device rather than on the volume: which voices exist depends on
   * the machine doing the speaking, so a phone and a laptop want different
   * answers and neither is wrong.
   */
  function chooseVoice(name: string) {
    setVoiceName(name);
    if (name) localStorage.setItem(VOICE_KEY, name);
    else localStorage.removeItem(VOICE_KEY);
    const voice = pickVoice(voices, name || undefined);
    if (!voice) return;
    const sample = new SpeechSynthesisUtterance("Nothing needs you. Everything is quiet.");
    sample.voice = voice;
    sample.lang = voice.lang;
    sample.rate = 1.08;
    speechSynthesis.cancel();
    speechSynthesis.speak(sample);
  }

  const field =
    "max-w-full min-w-0 rounded-[7px] border border-line bg-surface-2 px-2.5 py-1.5 font-mono text-[12px] outline-none placeholder:text-faint focus:border-accent";

  return (
    <section className="mt-8">
      <div className="mb-2.5 font-mono text-[11px] tracking-[.14em] text-faint uppercase">
        Assistant
      </div>
      <h2 className="mb-1 text-[21px] font-semibold tracking-tight">
        {draft?.name?.trim() || "Unnamed"}
      </h2>
      <div className="mb-3 text-sm text-muted">
        Its name, what it runs on, and any standing orders. Changes apply to the next thing you say,
        not to the turn in flight.
      </div>

      <div className="flex flex-col gap-2 rounded-[11px] border border-line bg-surface px-[15px] py-3">
        <div className="flex flex-wrap items-center gap-2">
          <input
            value={draft?.name ?? ""}
            onChange={(e) => setDraft((d) => d && { ...d, name: e.target.value })}
            aria-label="assistant name"
            placeholder="name"
            className={`w-[150px] ${field}`}
          />
          <input
            value={draft?.model ?? ""}
            onChange={(e) => setDraft((d) => d && { ...d, model: e.target.value })}
            aria-label="model"
            placeholder="model"
            className={`w-[150px] ${field}`}
          />
          <select
            value={draft?.effort ?? "low"}
            onChange={(e) =>
              setDraft((d) => d && { ...d, effort: e.target.value as AssistantConfig["effort"] })
            }
            aria-label="effort"
            className={field}
          >
            {EFFORTS.map((f) => (
              <option key={f} value={f}>
                {f} effort
              </option>
            ))}
          </select>
        </div>

        <textarea
          value={draft?.instructions ?? ""}
          onChange={(e) => setDraft((d) => d && { ...d, instructions: e.target.value })}
          rows={4}
          aria-label="standing orders"
          placeholder="Standing orders. Anything here overrides how it normally behaves, and is carried with every turn, so keep it short."
          className="w-full resize-y rounded-[7px] border border-line bg-surface-2 px-2.5 py-1.5 text-[13px] outline-none placeholder:text-faint focus:border-accent"
        />

        {/* The pod's own voices when it has them. They are the same on every
            device, unlike the browser's, and they are the reason voice mode no
            longer sounds like a machine — so the browser list is only offered
            when the pod has nothing. */}
        {podVoices.length > 0 ? (
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={podVoice}
              onChange={(e) => choosePodVoice(e.target.value)}
              aria-label="voice"
              className={`max-w-[280px] ${field}`}
            >
              <option value="">default ({voiceLabel(defaultVoice)})</option>
              {sortVoices(podVoices).map((v) => (
                <option key={v} value={v}>
                  {voiceLabel(v)}
                </option>
              ))}
            </select>
            <span className="font-mono text-[11px] text-faint">
              {sampling ? "speaking…" : "spoken on the pod · picking one plays a sample"}
            </span>
          </div>
        ) : (
          canSpeak() &&
          voices.length > 0 && (
            <div className="flex flex-wrap items-center gap-2">
              <select
                value={voiceName}
                onChange={(e) => chooseVoice(e.target.value)}
                aria-label="voice"
                className={`max-w-[280px] ${field}`}
              >
                <option value="">best available ({pickVoice(voices)?.name ?? "none"})</option>
                {voices.map((v) => (
                  <option key={`${v.name}-${v.lang}`} value={v.name}>
                    {v.name} · {v.lang}
                    {v.localService ? "" : " · network"}
                  </option>
                ))}
              </select>
              <span className="font-mono text-[11px] text-faint">
                this pod has no voice of its own, so the browser reads replies
              </span>
            </div>
          )
        )}

        <div className="flex items-center gap-3">
          <button
            onClick={() => void save()}
            disabled={!draft}
            className="tap rounded-[7px] bg-accent px-2.5 py-1.5 font-mono text-[12px] font-semibold text-on-accent hover:brightness-110 disabled:opacity-50"
          >
            save
          </button>
          {saved && <span className="font-mono text-[11px] text-run">saved</span>}
          {error && <span className="font-mono text-[11px] text-fail">{error}</span>}
          <span className="ml-auto font-mono text-[11px] text-faint">
            a bigger model follows instructions more closely and costs more
          </span>
        </div>
      </div>
      <CanDo />
    </section>
  );
}
