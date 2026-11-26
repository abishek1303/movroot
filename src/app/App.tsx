import { useInterfaceMotion } from "../components/motion/useInterfaceMotion";
import { AppearanceSegments } from "./AppearanceSegments";
import { gsap, useGSAP } from "../components/motion/engine";
import { accentNames, loadAppearance, saveAppearance } from "./appearance";
import model from "../../fixtures/file-semantic-v1.json";
import { useEffect, useRef, useState } from "react";
import { createFileAnalysis } from "../features/file-analysis/application/workflow";
import { createMuseFileAnalysis } from "../infrastructure/inference/muse-file-analysis";
import { InferencePanel } from "../features/inference/ui/InferencePanel";
import { createMuseEmber } from "../infrastructure/inference/muse-ember";
import { createMuseConnection } from "../infrastructure/inference/tauri-muse-transport";
import { DiscoveryScreen } from "../features/discovery/ui/DiscoveryScreen";
import { tauriDevice } from "../infrastructure/device/tauri-device";

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
  const shell = useRef<HTMLDivElement>(null);
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

  const motionEnabled = appearance.motion !== "reduced" && !systemReduced;
  useInterfaceMotion(shell, motionEnabled);
  const lastTab = useRef(tab);
  useGSAP(
    () => {
      const previous = lastTab.current;
      lastTab.current = tab;
      if (motionEnabled && previous !== tab) {
        gsap.fromTo(
          ".nav-indicator",
          { xPercent: tab === "history" ? -100 : 100 },
          {
            xPercent: 0,
            duration: 0.22,
            ease: "power2.out",
            clearProps: "transform",
          },
        );
      }
    },
    { scope: header, dependencies: [tab, motionEnabled], revertOnUpdate: true },
  );
  const previousControl = useRef(control);
  useGSAP(
    () => {
      const old = previousControl.current;
      previousControl.current = control;
      if (!motionEnabled || old === control) return;
      const panelFor = (name: typeof control) =>
        name === "appearance"
          ? appearancePanel.current
          : name === "settings"
            ? settingsPanel.current
            : null;
      const leaving = panelFor(old);
      const entering = panelFor(control);
      if (leaving)
        gsap.fromTo(
          leaving,
          { opacity: 1, y: 0 },
          {
            opacity: 0,
            y: -6,
            duration: 0.16,
            ease: "power1.in",
            clearProps: "transform,opacity",
          },
        );
      if (entering)
        gsap.fromTo(
          entering,
          { opacity: 0, y: -6 },
          {
            opacity: 1,
            y: 0,
            duration: 0.2,
            ease: "power2.out",
            clearProps: "transform,opacity",
          },
        );
    },
    { dependencies: [control, motionEnabled], revertOnUpdate: true },
  );

  useGSAP(
    () => {
      if (motionEnabled && shell.current) {
        const scene = [
          ...shell.current.querySelectorAll("[data-motion-scene]"),
        ].filter((element) => element.getClientRects().length);
        if (scene.length)
          gsap.from(scene, {
            opacity: 0.8,
            duration: 0.22,
            ease: "power2.out",
          });
      }
    },
    {
      scope: shell,
      dependencies: [appearance.mode, appearance.accent, motionEnabled],
      revertOnUpdate: true,
    },
  );

  function openSettings() {
    setOpenedSettings(true);
    setControl("settings");
  }

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
      ref={shell}
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
        <nav className="app-nav" aria-label="Workspace" data-tab={tab}>
          <span className="nav-indicator" aria-hidden="true" />
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
        inert={control !== "appearance"}
        data-open={control === "appearance"}
      >
        <div className="appearance-fields">
          <div className="appearance-title">Appearance</div>
          <AppearanceSegments
            label="Appearance mode"
            value={appearance.mode}
            motion={motionEnabled}
            onChange={(mode) => changeAppearance({ ...appearance, mode })}
            options={[
              { value: "system", label: "System", icon: "system" },
              { value: "light", label: "Light", icon: "light" },
              { value: "dark", label: "Dark", icon: "dark" },
            ]}
          />
          <span className="appearance-label">Accent color</span>
          <div
            className="accent-swatches"
            role="group"
            aria-label="Accent color"
          >
            {accentNames.map((accent) => (
              <button
                key={accent}
                className="accent-swatch"
                data-swatch={accent}
                title={accent[0].toUpperCase() + accent.slice(1)}
                aria-label={accent[0].toUpperCase() + accent.slice(1)}
                aria-pressed={appearance.accent === accent}
                onClick={() => changeAppearance({ ...appearance, accent })}
              >
                {appearance.accent === accent ? (
                  <span aria-hidden="true">✓</span>
                ) : null}
              </button>
            ))}
          </div>
          <span className="appearance-label motion-label">Motion</span>
          <AppearanceSegments
            label="Motion"
            value={appearance.motion}
            motion={motionEnabled}
            onChange={(motion) => changeAppearance({ ...appearance, motion })}
            options={[
              { value: "system", label: "System motion", icon: "motion" },
              { value: "reduced", label: "Reduce motion", icon: "reduced" },
            ]}
          />
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
        inert={control !== "settings"}
        data-open={control === "settings"}
      >
        {openedSettings && (
          <InferencePanel
            provider={provider}
            model={model.model}
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
            credentials={muse.credentials}
            onConfigure={openSettings}
            motionEnabled={tab === "organize" && motionEnabled}
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
