import { Link, useNavigate } from "react-router";

export default function TopBar({ crumb, back }: { crumb?: string[]; back?: string }) {
  const navigate = useNavigate();
  return (
    <header className="sticky top-0 z-20 flex items-center gap-3 border-b border-line bg-bg/90 px-[18px] py-3.5 pt-[max(14px,env(safe-area-inset-top))] backdrop-blur-md">
      {back !== undefined && (
        <button
          onClick={() => navigate(back)}
          className="flex-none rounded-[7px] border border-line bg-surface px-2.5 py-1.5 font-mono text-[13px] text-muted hover:border-faint hover:text-text"
        >
          ←
        </button>
      )}
      <Link to="/" className="flex items-center font-mono text-[15px] font-semibold tracking-wide">
        verksted
        <span className="ml-1 inline-block h-4 w-2 animate-blink bg-accent" />
      </Link>
      {crumb && crumb.length > 0 && (
        <div className="hidden min-w-0 items-center gap-1.5 font-mono text-[13px] text-muted min-[800px]:flex">
          {crumb.map((c) => (
            <span key={c} className="flex min-w-0 items-center gap-1.5">
              <span className="text-faint">/</span>
              <b className="overflow-hidden font-medium text-ellipsis whitespace-nowrap text-text">
                {c}
              </b>
            </span>
          ))}
        </div>
      )}
      <span className="ml-auto flex flex-none items-center gap-1.5 rounded-full border border-run/30 bg-run/5 px-2.5 py-1 font-mono text-[11px] tracking-wider text-run">
        <span className="h-1.5 w-1.5 rounded-full bg-run" />
        wg0
      </span>
    </header>
  );
}
