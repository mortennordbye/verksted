import { useEffect, type ReactNode } from "react";

export default function Sheet({
  title,
  sub,
  onClose,
  children,
}: {
  title: string;
  sub: string;
  onClose: () => void;
  children: ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-40 flex items-end justify-center bg-black/60 min-[800px]:items-center"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        role="dialog"
        aria-label={title}
        className="w-full max-w-[520px] rounded-t-2xl border border-line bg-surface px-[18px] pt-5 pb-[calc(20px+env(safe-area-inset-bottom))] min-[800px]:rounded-2xl"
      >
        <h2 className="mb-0.5 text-[15px] font-semibold">{title}</h2>
        <div className="mb-4 text-sm text-muted">{sub}</div>
        {children}
        <button
          onClick={onClose}
          className="mt-3 w-full p-[11px] font-mono text-[13px] text-muted"
        >
          cancel
        </button>
      </div>
    </div>
  );
}
