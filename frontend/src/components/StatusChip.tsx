const styles = {
  run: "text-run border-run/30 bg-run/5",
  idle: "text-muted border-line",
} as const;

export function StatusChip({ kind, label }: { kind: keyof typeof styles; label: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2 py-0.5 font-mono text-[11px] ${styles[kind]}`}
    >
      {label}
    </span>
  );
}

export function StatusDot({ running }: { running: boolean }) {
  return (
    <span
      className={`h-2 w-2 flex-none rounded-full ${running ? "animate-pulse-run bg-run" : "bg-idle"}`}
    />
  );
}

export const AGENT_DOT: Record<string, string> = {
  claude: "bg-claude",
  antigravity: "bg-antigravity",
  codex: "bg-codex",
};

export function AgentTag({ agent, label }: { agent: string; label?: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 font-mono text-[11px] text-muted">
      <i className={`h-[7px] w-[7px] flex-none rounded-[2px] ${AGENT_DOT[agent] ?? "bg-faint"}`} />
      {label ?? agent}
    </span>
  );
}
