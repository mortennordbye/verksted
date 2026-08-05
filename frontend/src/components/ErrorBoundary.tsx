import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * Keeps one bad render from blanking the whole app.
 *
 * Without this, any throw inside a screen unmounts the entire tree and leaves a
 * white page with no way back — and on an installed PWA there is no address bar
 * to navigate out of it either. Reload is the escape hatch, since the service
 * worker serves the shell offline anyway.
 */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // The pod has no client error reporting; the console is what a person on a
    // desktop can actually reach.
    console.error("render failed", error, info.componentStack);
  }

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <main className="mx-auto max-w-[700px] px-[18px] pt-[60px]">
        <div className="mb-2.5 font-mono text-[11px] tracking-[.14em] text-faint uppercase">
          something broke
        </div>
        <h1 className="mb-3 text-[21px] font-semibold tracking-tight">this screen crashed</h1>
        <p className="mb-4 text-sm text-muted">
          The sessions themselves are untouched — they live in tmux on the pod, not in this page.
        </p>
        <pre className="mb-5 overflow-x-auto rounded-[11px] border border-line bg-surface p-3 font-mono text-[12px] text-fail">
          {error.message}
        </pre>
        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => this.setState({ error: null })}
            className="rounded-[7px] border border-line px-3 py-1.5 font-mono text-[12px] text-muted hover:text-text"
          >
            try again
          </button>
          <a
            href="/"
            className="rounded-[7px] bg-accent px-3 py-1.5 font-mono text-[12px] font-semibold text-on-accent hover:brightness-110"
          >
            back to the hub
          </a>
        </div>
      </main>
    );
  }
}
