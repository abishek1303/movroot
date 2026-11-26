import { useEffect, useRef, useState } from "react";
import { createFileAnalysis } from "../features/file-analysis/application/workflow";
import { createMuseFileAnalysis } from "../infrastructure/inference/muse-file-analysis";
import { InferencePanel } from "../features/inference/ui/InferencePanel";
import { createMuseEmber } from "../infrastructure/inference/muse-ember";
import { createMuseConnection } from "../infrastructure/inference/tauri-muse-transport";
import { DiscoveryScreen } from "../features/discovery/ui/DiscoveryScreen";
import { tauriDevice } from "../infrastructure/device/tauri-device";

import { appearanceSchema, loadAppearance, saveAppearance } from "./appearance";
import type { Appearance } from "./appearance";

const muse = createMuseConnection();
const fileAnalysis = createFileAnalysis(createMuseFileAnalysis(muse));
const provider = createMuseEmber(muse.send);

export function App() {
  const [tab, setTab] = useState<"organize" | "history">("organize");
  const [control, setControl] = useState<"appearance" | "settings">();

  const [openedSettings, setOpenedSettings] = useState(false);
  const [appearance, setAppearance] = useState(() =>
    loadAppearance({ getItem: (key) => window.localStorage.getItem(key) }),
  );
  const [systemReduced, setSystemReduced] = useState(
    () =>
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  useEffect(() => {
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setSystemReduced(preference.matches);
    preference.addEventListener("change", update);
    update();
    return () => preference.removeEventListener("change", update);
  }, []);
  const [storageError, setStorageError] = useState(false);
  const header = useRef<HTMLElement>(null);
  const appearanceButton = useRef<HTMLButtonElement>(null);
  const settingsButton = useRef<HTMLButtonElement>(null);
  const appearancePanel = useRef<HTMLElement>(null);
  const settingsPanel = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!control) return;
    const panel =
      control === "appearance"
        ? appearancePanel.current
        : settingsPanel.current;
    const trigger =
      control === "appearance"
        ? appearanceButton.current
        : settingsButton.current;
    panel?.focus();
    function dismiss(event: PointerEvent) {
      if (
        event.target instanceof Node &&
        !panel?.contains(event.target) &&
        !header.current
          ?.querySelector(".header-controls")
          ?.contains(event.target)
      ) {
        if (panel?.contains(document.activeElement)) trigger?.focus();
        setControl(undefined);
      }
    }
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [control]);

  function changeAppearance(value: Appearance) {
    setAppearance(value);
    setStorageError(
      !saveAppearance(
        { setItem: (key, value) => window.localStorage.setItem(key, value) },
        value,
      ),
    );
  }

  return (
    <div
      className="app-shell"
      data-mode={appearance.mode}
      data-accent={appearance.accent}
      data-motion={appearance.motion}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || event.defaultPrevented || !control)
          return;
        event.preventDefault();
        (control === "appearance"
          ? appearanceButton.current
          : settingsButton.current
        )?.focus();
        setControl(undefined);
      }}
    >
      <header className="app-header" ref={header}>
        <h1>
          <svg aria-hidden="true" viewBox="0 0 24 24">
            <path d="M12 22V2M12 12l-7-6M12 16l7-6M12 19l-8-5M17 17l4-3" />
          </svg>{" "}
          Movroot
        </h1>
        <nav className="app-nav" aria-label="Workspace">
          <button
            type="button"
            aria-current={tab === "organize" ? "page" : undefined}
            onClick={() => setTab("organize")}
          >
            Organize
          </button>
          <button
            type="button"
            aria-current={tab === "history" ? "page" : undefined}
            onClick={() => setTab("history")}
          >
            History
          </button>
        </nav>
        <div className="header-controls">
          <button
            type="button"
            aria-expanded={control === "appearance"}
            aria-controls="appearance-panel"
            ref={appearanceButton}
            title="Appearance"
            aria-label="Appearance"
            onClick={() =>
              setControl(control === "appearance" ? undefined : "appearance")
            }
          >
            <svg aria-hidden="true" viewBox="0 0 24 24">
              <path d="M12 3a9 9 0 1 0 0 18h1a2 2 0 0 0 1-3.7 1 1 0 0 1 .5-1.8H17a4 4 0 0 0 4-4C21 6.8 17 3 12 3Z" />
              <path d="M7.5 11h.01M10 7.5h.01M14 7.5h.01M17 10h.01" />
            </svg>
          </button>
          <button
            type="button"
            aria-expanded={control === "settings"}
            aria-controls="settings-panel"
            ref={settingsButton}
            title="Settings"
            aria-label="Settings"
            onClick={() => {
              setOpenedSettings(true);
              setControl(control === "settings" ? undefined : "settings");
            }}
          >
            <svg aria-hidden="true" viewBox="0 0 24 24">
              <path d="m10 3-.5 3-2 .9-2.6-1.6L3 8.6l2.2 2.1v2.6L3 15.4l1.9 3.3 2.6-1.6 2 .9.5 3h4l.5-3 2-.9 2.6 1.6 1.9-3.3-2.2-2.1v-2.6L21 8.6l-1.9-3.3-2.6 1.6-2-.9-.5-3Z" />
              <circle cx="12" cy="12" r="3" />
            </svg>
          </button>
        </div>
      </header>
      <aside
        id="appearance-panel"
        ref={appearancePanel}
        aria-label="Appearance"
        tabIndex={-1}
        className="header-panel"
        hidden={control !== "appearance"}
      >
        <div className="appearance-fields">
          {(["mode", "accent", "motion"] as const).map((field) => (
            <label key={field}>
              {
                { mode: "Appearance", accent: "Accent", motion: "Motion" }[
                  field
                ]
              }
              <select
                value={appearance[field]}
                onChange={(event) => {
                  const value = appearanceSchema.safeParse({
                    ...appearance,
                    [field]: event.target.value,
                  });
                  if (value.success) changeAppearance(value.data);
                }}
              >
                {appearanceSchema.shape[field].options.map((option) => (
                  <option key={option} value={option}>
                    {option[0].toUpperCase() + option.slice(1)}
                  </option>
                ))}
              </select>
            </label>
          ))}
          {storageError && (
            <p role="status">Appearance changes could not be saved.</p>
          )}
        </div>
      </aside>
      <aside
        id="settings-panel"
        ref={settingsPanel}
        aria-label="Settings"
        tabIndex={-1}
        className="header-panel"
        hidden={control !== "settings"}
      >
        {openedSettings && (
          <InferencePanel
            provider={provider}
            credentials={muse.credentials}
            visible={control === "settings"}
          />
        )}
      </aside>
      <main className="app-content">
        <div className="workspace" hidden={tab !== "organize"}>
          <DiscoveryScreen
            device={tauriDevice}
            analysis={fileAnalysis}
            motionEnabled={
              tab === "organize" &&
              appearance.motion !== "reduced" &&
              !systemReduced
            }
          />
        </div>
        <section
          className="history"
          aria-label="History"
          hidden={tab !== "history"}
        >
          <p>No operations yet</p>
        </section>
      </main>
    </div>
  );
}
