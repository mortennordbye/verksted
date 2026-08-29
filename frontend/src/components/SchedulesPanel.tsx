import { useState } from "react";
import { Link } from "react-router";
import type {
  CouncilMember,
  MaintainerStage,
  Project,
  Schedule,
  Settings as SettingsInfo,
} from "../../../shared/api";
import { agoLabel, api, usePoll } from "../api";
import { useConfirm } from "../useConfirm";
import { ReportLine, StatusChip } from "./StatusChip";

/** A cron pattern's next fire time, in this device's timezone. */
function whenLabel(iso: string | null): string {
  if (!iso) return "paused";
  return new Date(iso).toLocaleString([], {
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** A run's own verdict, coloured by the word it starts with. */
function reportChip(report: string) {
  const kind = /^attention\b/i.test(report) ? "wait" : /^failed\b/i.test(report) ? "fail" : "run";
  return <ReportLine kind={kind} text={report} />;
}

const CRON_PRESETS = [
  { cron: "0 8 * * 1-5", label: "weekdays 08:00" },
  { cron: "0 * * * *", label: "hourly" },
  { cron: "0 7 * * *", label: "daily 07:00" },
];

/**
 * Recurring prompts. Each one starts a claude session in its project on the
 * cron and submits the prompt, in auto permission mode — nobody is there to
 * answer a permission question at 07:00. The run shows up as an ordinary
 * session, so it pushes and can be taken over from the phone like any other.
 *
 * With `project` set the panel is scoped to that repo: it lists only that
 * repo's schedules and creates new ones in it. Without it, it is the global
 * list on the settings screen, where the project is a field on every row.
 */
export default function SchedulesPanel({ project }: { project?: string }) {
  const { data: schedules, refresh } = usePoll<Schedule[]>(
    project ? `/api/projects/${project}/schedules` : "/api/schedules",
    30_000,
  );
  // Only the global list needs the picker; a project-scoped one already knows.
  const { data: projects } = usePoll<Project[]>(project ? null : "/api/projects", 60_000);
  // "Where it runs" and "who answers it" are the same question asked once, so
  // the roster joins the repos in one control rather than adding a second.
  const { data: council } = usePoll<CouncilMember[]>(project ? null : "/api/council", 120_000);
  const { data: settings, refresh: refreshSettings } = usePoll<SettingsInfo>(
    "/api/settings",
    30_000,
  );
  const [draft, setDraft] = useState({
    name: "",
    // A schedule that runs the assistant belongs to no repo, so the choice only
    // exists on the global list; inside a project it is always that project's.
    kind: "session" as Schedule["kind"],
    project: "",
    cron: "0 8 * * 1-5",
    jitterMinutes: 0,
    prompt: "",
    // Which council member answers an assistant schedule. Empty is the chair.
    member: "",
    // Off by default: turning it on turns one model call into as many as five.
    convenes: false,
    // A shipped maintainer stage instead of a prompt of its own; empty is a
    // prompt. Session schedules only.
    stage: "" as "" | MaintainerStage,
  });
  const [open, setOpen] = useState<string | null>(null);
  const [edit, setEdit] = useState({ cron: "", jitterMinutes: 0, prompt: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  async function run(fn: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      await fn();
      refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const assistantDraft = !project && draft.kind === "assistant";

  const add = () =>
    run(async () => {
      const { project: drafted, stage, ...rest } = draft;
      await api("/api/schedules", {
        method: "POST",
        body: JSON.stringify(
          assistantDraft
            ? { ...rest, kind: "assistant" }
            : {
                ...rest,
                kind: "session",
                project: project ?? drafted ?? projects?.[0]?.name,
                ...(stage ? { stage } : {}),
              },
        ),
      });
      setDraft({ ...draft, name: "", prompt: "" });
    });

  const patch = (s: Schedule, body: Partial<Schedule>) =>
    run(() => api(`/api/schedules/${s.id}`, { method: "PATCH", body: JSON.stringify(body) }));

  const runNow = (s: Schedule) =>
    run(async () => {
      const result = await api<{ reply?: string }>(`/api/schedules/${s.id}/run`, {
        method: "POST",
        // An assistant run answers only when the turn is done, which is a whole
        // model call away; the default 15s would give up on a working request.
        timeoutMs: s.kind === "assistant" ? 11 * 60_000 : undefined,
      });
      // An assistant run has no session to open, so the reply is the only thing
      // there is to show — and waiting for it is the whole point of pressing it.
      setNote(result.reply ?? `started a session for "${s.name}"`);
    });

  const [confirm, confirmDialog] = useConfirm();

  const remove = async (s: Schedule) => {
    const ok = await confirm({
      title: `Delete the schedule "${s.name}"?`,
      body: "It stops firing. Sessions it already started are untouched.",
      action: "delete the schedule",
      danger: true,
    });
    if (ok) void run(() => api(`/api/schedules/${s.id}`, { method: "DELETE" }));
  };

  function toggleOpen(s: Schedule) {
    setOpen(open === s.id ? null : s.id);
    setEdit({ cron: s.cron, jitterMinutes: s.jitterMinutes, prompt: s.prompt });
  }

  const field =
    "max-w-full min-w-0 rounded-[7px] border border-line bg-surface-2 px-2.5 py-1.5 font-mono text-[12px] outline-none placeholder:text-faint focus:border-accent";
  const ghost =
    "tap rounded-[7px] border border-line px-2.5 py-1.5 font-mono text-[12px] text-muted hover:border-faint hover:text-text disabled:opacity-50";

  return (
    <>
      <div className={`mb-2.5 flex flex-wrap items-center gap-2.5 ${project ? "" : "mt-10"}`}>
        <span className="font-mono text-[11px] tracking-[.12em] text-faint uppercase">
          {project ? "Recurring prompts" : "Schedules · recurring prompts"}
        </span>
        {/* Worth showing here too: a globally paused scheduler is why this
            repo's schedules are not firing, and it is set on another screen. */}
        {settings?.schedulesPaused && <StatusChip kind="wait" label="all paused" />}
        {/* The switch itself stays on the settings screen — it stops every
            repo's schedules, which is not what a per-project button reads as. */}
        {!project && (
          <button
            onClick={() =>
              run(async () => {
                await api("/api/settings", {
                  method: "PUT",
                  body: JSON.stringify({ schedulesPaused: !settings?.schedulesPaused }),
                });
                refreshSettings();
              })
            }
            disabled={busy || !settings}
            title="stop every schedule firing on its cron; run now still works"
            className={`ml-auto ${ghost}`}
          >
            {settings?.schedulesPaused ? "resume all" : "pause all"}
          </button>
        )}
      </div>
      {error && <div className="mb-3 font-mono text-[12px] text-wait">{error}</div>}
      {note && <div className="mb-3 font-mono text-[12px] text-muted">{note}</div>}
      <div className="flex flex-col gap-2">
        {(schedules ?? []).map((s) => (
          <div key={s.id} className="rounded-[11px] border border-line bg-surface px-[15px] py-2.5">
            <div className="flex flex-wrap items-center gap-2.5">
              <span className="font-mono text-[12.5px]">{s.name}</span>
              {!project && (
                <span className="font-mono text-[11px] text-faint">
                  {s.kind === "assistant"
                    ? (council?.find((m) => m.id === (s.member || "chair"))?.name ??
                      "the assistant")
                    : s.project}
                </span>
              )}
              <StatusChip
                kind={s.enabled ? "run" : "idle"}
                label={s.enabled ? whenLabel(s.nextRunAt) : "paused"}
              />
              <span className="ml-auto flex flex-wrap gap-2">
                <button onClick={() => toggleOpen(s)} className={ghost}>
                  {open === s.id ? "hide" : "edit"}
                </button>
                <button onClick={() => runNow(s)} disabled={busy} className={ghost}>
                  run now
                </button>
                <button
                  onClick={() => patch(s, { enabled: !s.enabled })}
                  disabled={busy}
                  className={ghost}
                >
                  {s.enabled ? "pause" : "resume"}
                </button>
                <button
                  onClick={() => remove(s)}
                  disabled={busy}
                  className="tap rounded-[7px] border border-line px-2.5 py-1.5 font-mono text-[12px] text-muted hover:border-wait hover:text-wait disabled:opacity-50"
                >
                  delete
                </button>
              </span>
            </div>
            <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11px] text-faint">
              <span>{s.cron}</span>
              {s.stage && <span>stage: {s.stage}</span>}
              {s.jitterMinutes > 0 && <span>±{s.jitterMinutes} min jitter</span>}
              {s.skipWhenIdle && <span>skips a day when nothing ended</span>}
              {s.convenes && <span>may ask the council</span>}
              <span>last run {agoLabel(s.lastRunAt)}</span>
              {s.lastSessionId && (
                <Link to={`/s/${s.lastSessionId}`} className="text-muted hover:text-accent">
                  {s.lastSessionId}
                </Link>
              )}
              {s.lastError && <span className="min-w-0 break-words text-wait">{s.lastError}</span>}
            </div>
            {s.lastReport && <div className="mt-1.5">{reportChip(s.lastReport)}</div>}
            {open === s.id ? (
              <div className="mt-2 flex flex-col gap-2">
                <div className="flex flex-wrap items-center gap-2.5">
                  <input
                    value={edit.cron}
                    onChange={(e) => setEdit((d) => ({ ...d, cron: e.target.value }))}
                    placeholder="0 8 * * 1-5"
                    aria-label="cron pattern"
                    className={`w-[200px] ${field}`}
                  />
                  <label className="font-mono text-[11px] text-faint">
                    jitter
                    <input
                      type="number"
                      min={0}
                      max={720}
                      value={edit.jitterMinutes}
                      onChange={(e) =>
                        setEdit((d) => ({ ...d, jitterMinutes: Number(e.target.value) }))
                      }
                      className={`ml-2 w-[72px] ${field}`}
                    />
                    <span className="ml-1.5">min</span>
                  </label>
                </div>
                <textarea
                  value={edit.prompt}
                  onChange={(e) => setEdit((d) => ({ ...d, prompt: e.target.value }))}
                  rows={3}
                  aria-label="prompt"
                  className={`w-full resize-y ${field}`}
                />
                <button
                  onClick={() => patch(s, edit).then(() => setOpen(null))}
                  disabled={busy || !edit.cron.trim() || (!edit.prompt.trim() && !s.stage)}
                  className="tap self-start rounded-[7px] bg-accent px-2.5 py-1.5 font-mono text-[12px] font-semibold text-on-accent hover:brightness-110 disabled:opacity-50"
                >
                  save
                </button>
              </div>
            ) : (
              <div className="mt-1.5 line-clamp-2 text-[12.5px] text-muted">{s.prompt}</div>
            )}
          </div>
        ))}
        {schedules?.length === 0 && (
          <div className="font-mono text-[12.5px] text-faint">
            {project ? `no schedules in ~/${project}` : "no schedules"}
          </div>
        )}

        <div className="flex flex-col gap-2 rounded-[11px] border border-dashed border-line px-[15px] py-2.5">
          <div className="flex flex-wrap items-center gap-2.5">
            <input
              value={draft.name}
              onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
              placeholder="what it does"
              aria-label="schedule name"
              className={`w-[200px] ${field}`}
            />
            {!project && (
              <select
                value={
                  draft.kind === "assistant"
                    ? `member:${draft.member}`
                    : draft.project || projects?.[0]?.name || ""
                }
                onChange={(e) =>
                  setDraft((d) =>
                    e.target.value.startsWith("member:")
                      ? {
                          ...d,
                          kind: "assistant",
                          member: e.target.value.slice("member:".length),
                        }
                      : { ...d, kind: "session", project: e.target.value },
                  )
                }
                aria-label="who runs it"
                className={field}
              >
                {/* One control, because "which repo" and "which of the council
                    instead of a repo" are the same question asked once. */}
                {(council ?? [{ id: "chair", name: "the assistant", chair: true }]).map((m) => (
                  <option key={m.id} value={`member:${m.chair ? "" : m.id}`}>
                    {m.name} (no repo)
                  </option>
                ))}
                {(projects ?? []).map((p) => (
                  <option key={p.name} value={p.name}>
                    {p.name}
                  </option>
                ))}
              </select>
            )}
            <input
              value={draft.cron}
              onChange={(e) => setDraft((d) => ({ ...d, cron: e.target.value }))}
              placeholder="0 8 * * 1-5"
              aria-label="cron pattern"
              className={`w-[130px] ${field}`}
            />
            {!assistantDraft && (
              <select
                value={draft.stage}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, stage: e.target.value as "" | MaintainerStage }))
                }
                aria-label="stage"
                className={field}
              >
                <option value="">own prompt</option>
                <option value="scout">maintainer: scout</option>
              </select>
            )}
            {assistantDraft && !draft.member && (
              <label className="flex items-center gap-1.5 font-mono text-[11px] text-faint">
                <input
                  type="checkbox"
                  checked={draft.convenes}
                  onChange={(e) => setDraft((d) => ({ ...d, convenes: e.target.checked }))}
                />
                may ask the council
              </label>
            )}
            <label className="font-mono text-[11px] text-faint">
              jitter
              <input
                type="number"
                min={0}
                max={720}
                value={draft.jitterMinutes}
                onChange={(e) => setDraft((d) => ({ ...d, jitterMinutes: Number(e.target.value) }))}
                className={`mx-2 w-[72px] ${field}`}
              />
              min
            </label>
            {CRON_PRESETS.map((p) => (
              <button
                key={p.cron}
                onClick={() => setDraft((d) => ({ ...d, cron: p.cron }))}
                className="tap font-mono text-[11px] text-faint hover:text-accent"
              >
                {p.label}
              </button>
            ))}
          </div>
          <textarea
            value={draft.prompt}
            onChange={(e) => setDraft((d) => ({ ...d, prompt: e.target.value }))}
            placeholder={
              assistantDraft
                ? "What needs me today? Anything red, stuck, or waiting on me."
                : draft.stage
                  ? "notes for the maintainer (optional)"
                  : "Check the open pull requests and merge any that are approved and green."
            }
            rows={3}
            aria-label="prompt"
            className={`w-full resize-y ${field}`}
          />
          <button
            onClick={add}
            disabled={
              busy ||
              !draft.name.trim() ||
              (!draft.prompt.trim() && !(draft.stage && !assistantDraft)) ||
              (!project && !assistantDraft && !projects?.length)
            }
            className="tap self-start rounded-[7px] bg-accent px-2.5 py-1.5 font-mono text-[12px] font-semibold text-on-accent hover:brightness-110 disabled:opacity-50"
          >
            add schedule
          </button>
        </div>
      </div>
      <div className="mt-5 text-[13px] text-muted">
        Cron patterns are read in the pod's timezone; times above are shown in this device's, before
        jitter — a jittered run starts somewhere in the window after it. A tick is skipped while the
        schedule's previous session is still open. Runs start in auto permission mode: routine tool
        calls go through unattended, and anything the agent still has to ask about turns the session
        amber and pushes you. Every run is asked to sign off with one line — "ok: …", "attention: …"
        or "failed: …" — which shows up here and is what the phone gets. A run that reports itself
        ok stays silent. A maintainer stage runs the other way round: its permissions deny rather
        than ask, so it never turns amber — it finishes with a report, or is ended for it after
        ninety minutes and recorded as failed.
      </div>
      {!project && (
        <div className="mt-2.5 text-[13px] text-muted">
          A schedule set to the assistant runs it instead of starting a session: no repo, no
          terminal, and no way to change anything — it reads the bench, answers in a line or two,
          and pushes your phone only when something should interrupt you. The answer lands in the
          inbox either way, and the same notification is not repeated within a few hours.
        </div>
      )}
      {confirmDialog}
    </>
  );
}
