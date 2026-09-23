import { useState } from "react";
import { readStored, removeStored, writeStored } from "../../storage";
import SectionLabel from "../SectionLabel";
import SegTabs from "../ui/SegTabs";

type Mode = "system" | "light" | "dark";

/** Read before first paint by public/theme-mode.js, which knows the same key. */
const MODE_KEY = "vk.theme";

function storedMode(): Mode {
  const mode = readStored(MODE_KEY);
  return mode === "light" || mode === "dark" ? mode : "system";
}

/**
 * Light, dark, or whatever the system is set to. Per device, like the
 * terminal's font size: a phone and a desk screen are read in different light.
 * The terminal stays dark in every mode.
 */
export default function Appearance() {
  const [mode, setMode] = useState(storedMode);

  function choose(next: Mode) {
    setMode(next);
    if (next === "system") {
      removeStored(MODE_KEY);
      delete document.documentElement.dataset.theme;
    } else {
      writeStored(MODE_KEY, next);
      document.documentElement.dataset.theme = next;
    }
  }

  return (
    <>
      <SectionLabel icon="settings" className="mt-10">
        Appearance
      </SectionLabel>
      <div className="flex flex-wrap items-center gap-2.5 rounded-[11px] border border-line bg-surface px-[15px] py-2.5">
        <span className="text-[13px]">mode</span>
        <SegTabs
          label="mode"
          value={mode}
          onChange={choose}
          items={[
            { value: "system", content: "system" },
            { value: "light", content: "light" },
            { value: "dark", content: "dark" },
          ]}
          className="ml-auto flex gap-1.5"
        />
      </div>
      <div className="mt-5 text-[13px] text-muted">
        Kept on this device only. The terminal stays dark in every mode.
      </div>
    </>
  );
}
