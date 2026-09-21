import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import Button from "../src/components/ui/Button";
import { Input } from "../src/components/ui/Field";
import Notice from "../src/components/ui/Notice";
import SegTabs from "../src/components/ui/SegTabs";
import { offerUndo, resetToasts, toast, Toaster } from "../src/components/ui/Toast";

/**
 * Root cause 6's primitives (F-21, F-23, F-40): the shared button, field,
 * strip, notice and toast every screen outside the chat now draws with.
 */
afterEach(() => {
  cleanup();
  resetToasts();
});

describe("a button", () => {
  it("does not submit the form it sits in unless asked to", () => {
    const submit = vi.fn((e: Event) => e.preventDefault());
    render(
      <form onSubmit={(e) => submit(e.nativeEvent)}>
        <Button>cancel</Button>
      </form>,
    );
    fireEvent.click(screen.getByRole("button", { name: "cancel" }));
    expect(submit).not.toHaveBeenCalled();
  });
});

describe("a field", () => {
  it("is named by its label, not its placeholder", () => {
    render(<Input label="branch name" placeholder="feature-x" />);
    expect(screen.getByRole("textbox", { name: "branch name" })).toBeTruthy();
  });
});

describe("a notice", () => {
  it("announces a failure as an alert and the rest as a status", () => {
    render(
      <>
        <Notice kind="fail">push refused</Notice>
        <Notice kind="ok">pushed</Notice>
      </>,
    );
    expect(screen.getByRole("alert").textContent).toContain("push refused");
    expect(screen.getByRole("status").textContent).toContain("pushed");
  });

  it("can be put away when it outlives its moment", () => {
    const dismiss = vi.fn();
    render(
      <Notice kind="fail" onDismiss={dismiss}>
        kill failed
      </Notice>,
    );
    fireEvent.click(screen.getByRole("button", { name: "dismiss" }));
    expect(dismiss).toHaveBeenCalledTimes(1);
  });
});

describe("a strip of views", () => {
  function Strip() {
    const [v, setV] = useState<"a" | "b">("a");
    return (
      <SegTabs
        label="view"
        value={v}
        onChange={setV}
        items={[
          { value: "a", content: "alpha" },
          { value: "b", content: "beta" },
        ]}
      />
    );
  }

  it("is one choice out of a set, and choosing the one on keeps it on", () => {
    render(<Strip />);
    const group = screen.getByRole("radiogroup", { name: "view" });
    const [alpha, beta] = within(group).getAllByRole("radio");
    fireEvent.click(beta);
    expect(beta.getAttribute("aria-checked")).toBe("true");
    expect(alpha.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(beta);
    expect(beta.getAttribute("aria-checked")).toBe("true");
  });
});

describe("a toast", () => {
  it("says a passing result in the one region", () => {
    render(<Toaster />);
    act(() => toast("copied"));
    expect(screen.getByText("copied").closest("ol")).not.toBeNull();
  });

  it("offers undo for the last thing only", () => {
    const first = vi.fn();
    const second = vi.fn();
    render(<Toaster />);
    act(() => offerUndo("closed one", first));
    act(() => offerUndo("closed two", second));
    expect(screen.queryByText("closed one")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "undo" }));
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
  });
});
