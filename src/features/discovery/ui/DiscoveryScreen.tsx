import { DiscoverPopover } from "./DiscoverPopover";
import type { CredentialSettings } from "../../inference/application/provider";
import { gsap, useGSAP } from "../../../components/motion/engine";
import type { FileAnalysis } from "../../file-analysis/application/workflow";
import { FileAnalysisPanel } from "../../file-analysis/ui/FileAnalysisPanel";
import { useEffect, useRef, useState } from "react";
import type { DeviceScope, Discovery, FileId } from "../application/contracts";
import type { DeviceAdapter } from "../application/device";

export function DiscoveryScreen({
  device,
  analysis,
  motionEnabled,
  credentials,
  onConfigure,
}: {
  device: DeviceAdapter;
  analysis: FileAnalysis;
  motionEnabled: boolean;
  credentials: CredentialSettings;
  onConfigure: () => void;
}) {
  const [scope, setScope] = useState<DeviceScope>();
  const [review, setReview] = useState(false);
  const [analysisBusy, setAnalysisBusy] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const [status, setStatus] = useState("");
  const [reset, setReset] = useState(false);
  const [resetController, setResetController] = useState(
    () => new AbortController(),
  );
  const resetDialog = useRef<HTMLDialogElement>(null);
  const resetButton = useRef<HTMLButtonElement>(null);
  const chooseButton = useRef<HTMLButtonElement>(null);
  const restoreChooseFocus = useRef(false);
  const organize = useRef<HTMLElement>(null);
  const revision = useRef(0);
  const [listingVersion, setListingVersion] = useState(0);
  const [listing, setListing] = useState<Discovery>();
  const [discoveredCount, setDiscoveredCount] = useState<number>();

  const [scanning, setScanning] = useState(false);
  const scan = useRef<AbortController | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [preview, setPreview] = useState<{
    url: string;
    name: string;
    fileId: FileId;
  }>();
  const previewUrl = useRef<string | undefined>(undefined);

  function discardPreview() {
    if (previewUrl.current) URL.revokeObjectURL(previewUrl.current);
    previewUrl.current = undefined;
    setPreview(undefined);
  }

  useEffect(
    () => () => {
      revision.current += 1;
      scan.current?.abort();
      if (previewUrl.current) URL.revokeObjectURL(previewUrl.current);
    },
    [],
  );

  async function requestPreview(fileId: FileId, name: string) {
    if (!scope || scan.current) return;
    const request = ++revision.current;
    const controller = new AbortController();
    scan.current = controller;
    setPreviewing(true);
    discardPreview();
    setStatus("Generating preview…");
    const result = await device.readFile(
      scope.scopeId,
      fileId,
      "imagePreview",
      8 * 1024 * 1024,
      controller.signal,
    );
    scan.current = null;
    setPreviewing(false);
    if (request !== revision.current) return;
    if (controller.signal.aborted) {
      setStatus("Preview cancelled.");
    } else if (!result.ok) {
      setStatus(
        result.error === "resourceChanged" || result.error === "unknownFile"
          ? "The file changed. Refresh discovery and try again."
          : `Preview unavailable (${result.error}).`,
      );
    } else {
      const url = URL.createObjectURL(
        new Blob([new Uint8Array(result.value)], { type: "image/png" }),
      );
      previewUrl.current = url;
      setPreview({ url, name, fileId });
      setStatus("Loading generated preview…");
    }
  }

  async function discover(target = scope) {
    if (!target || scan.current || analysisBusy) return;
    const request = ++revision.current;
    const controller = new AbortController();
    scan.current = controller;
    discardPreview();
    setScanning(true);
    setStatus("Discovering files…");
    const result = await device.discover(target.scopeId, controller.signal);
    scan.current = null;
    setScanning(false);
    if (request !== revision.current) return;
    if (
      controller.signal.aborted ||
      (result.ok && result.value.status === "cancelled")
    ) {
      if (result.ok && result.value.status !== "cancelled") {
        setListing(undefined);
        setReview(false);
      }
      setStatus(
        "Discovery cancelled. Any displayed files are from the previous scan.",
      );
    } else if (!result.ok) {
      setStatus(
        "Discovery failed. Any displayed files are from the previous scan.",
      );
    } else {
      setReview(false);
      setListing(result.value);
      setListingVersion((value) => value + 1);
      setDiscoveredCount(result.value.files.length);
      setStatus(
        result.value.status === "complete"
          ? ""
          : result.value.status === "partial"
            ? "Some items could not be listed."
            : "Only part of this folder could be scanned.",
      );
    }
  }

  async function selectFolder() {
    const request = ++revision.current;
    setSelecting(true);
    setStatus("");
    const result = await device.selectScope();
    setSelecting(false);
    if (request !== revision.current) return;
    if (!result.ok) {
      setStatus("Could not authorize the selected folder.");
    } else if (result.value.status === "selected") {
      discardPreview();
      setListing(undefined);
      setReview(false);
      setScope(result.value.scope);
      await discover(result.value.scope);
    } else {
      setStatus("Folder selection cancelled.");
    }
  }

  function beginReset() {
    resetController.abort();
    if (scan.current) {
      scan.current.abort();
    }
    setReset(true);
    setStatus("Starting over…");
  }

  useEffect(() => {
    if (!reset || !scope || scanning || previewing || analysisBusy) return;
    let current = true;
    void device.clearScope(scope.scopeId).then((result) => {
      if (!current) return;
      setResetController(new AbortController());
      setReset(false);
      if (result.ok || result.error === "scopeInactive") {
        revision.current++;
        if (previewUrl.current) URL.revokeObjectURL(previewUrl.current);
        previewUrl.current = undefined;
        setPreview(undefined);
        setListing(undefined);
        setScope(undefined);
        setDiscoveredCount(undefined);
        setReview(false);
        setStatus("");
        restoreChooseFocus.current = true;
      } else {
        setStatus("Could not clear the folder. Try again.");
        resetButton.current?.focus();
      }
    });
    return () => {
      current = false;
    };
  }, [reset, scope, scanning, previewing, analysisBusy, device]);

  const step = review
    ? 2
    : listing?.files.length && discoveredCount === undefined
      ? 1
      : 0;
  const busy = selecting || reset || scanning || previewing || analysisBusy;
  useGSAP(
    () => {
      if (motionEnabled && organize.current) {
        gsap.from(".stepper [aria-current] > span", {
          scale: 0.84,
          duration: 0.18,
          ease: "power2.out",
        });
        gsap.from(".folder-start, .organize-body", {
          opacity: 0.72,
          y: 4,
          duration: 0.2,
          ease: "power2.out",
        });
      }
    },
    {
      scope: organize,
      dependencies: [step, scope, motionEnabled],
      revertOnUpdate: true,
    },
  );
  useEffect(() => {
    if (!scope && restoreChooseFocus.current) {
      chooseButton.current?.focus();
      restoreChooseFocus.current = false;
    }
  }, [scope]);
  return (
    <section className="organize" aria-label="Organize" ref={organize}>
      <ol className="stepper" aria-label="Organize progress">
        {["Discover", "Analyze", "Organize"].map((label, index) => (
          <li
            key={label}
            aria-current={index === step ? "step" : undefined}
            data-complete={index < step}
          >
            <span aria-hidden="true">{index < step ? "✓" : index + 1}</span>
            {label}
          </li>
        ))}
      </ol>
      {!scope ? (
        <div className="folder-start">
          <button
            ref={chooseButton}
            className="choose-folder primary"
            type="button"
            disabled={selecting}
            onClick={() => void selectFolder()}
          >
            <svg aria-hidden="true" viewBox="0 0 24 24">
              <path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
            </svg>
            {selecting ? "Choosing folder…" : "Choose folder"}
          </button>
          {status && <p role="status">{status}</p>}
        </div>
      ) : (
        <div className="organize-body">
          <div
            className={`folder-toolbar folder-context${step === 0 ? " discover-folder-context" : ""}`}
          >
            <strong>
              <svg aria-hidden="true" viewBox="0 0 24 24">
                <path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
              </svg>
              {scope.label}
            </strong>
            {step === 0 ? (
              <DiscoverPopover
                label="Folder actions"
                motion={motionEnabled}
                triggerRef={resetButton}
                disabled={reset || selecting}
                icon={
                  <svg aria-hidden="true" viewBox="0 0 24 24">
                    <path d="M5 12h.01m7 0h.01m7 0h.01" strokeWidth="3" />
                  </svg>
                }
              >
                <div className="folder-command-list">
                  <button
                    data-dismiss-popover
                    disabled={busy}
                    onClick={() => {
                      void selectFolder();
                    }}
                  >
                    <svg aria-hidden="true" viewBox="0 0 24 24">
                      <path d="M3 6h7l2 2h9v12H3Z" />
                    </svg>
                    Change folder
                  </button>
                  <button
                    data-dismiss-popover
                    disabled={busy}
                    onClick={() => {
                      void discover();
                    }}
                  >
                    <svg aria-hidden="true" viewBox="0 0 24 24">
                      <path d="M20 11a8 8 0 1 0-2 6m2-12v6h-6" />
                    </svg>
                    Refresh
                  </button>
                  <button
                    data-dismiss-popover
                    onClick={() => {
                      if (
                        analysisBusy ||
                        scanning ||
                        previewing ||
                        listing?.files.length
                      )
                        resetDialog.current?.showModal();
                      else beginReset();
                    }}
                  >
                    <svg aria-hidden="true" viewBox="0 0 24 24">
                      <path d="M4 11a8 8 0 1 1 2 6M4 5v6h6" />
                    </svg>
                    Start over
                  </button>
                </div>
              </DiscoverPopover>
            ) : (
              <>
                <button
                  className="subtle"
                  ref={resetButton}
                  disabled={reset}
                  onClick={() => {
                    if (
                      analysisBusy ||
                      scanning ||
                      previewing ||
                      listing?.files.length
                    )
                      resetDialog.current?.showModal();
                    else beginReset();
                  }}
                >
                  Start over
                </button>
                {!busy && !listing?.files.length && (
                  <button className="subtle" onClick={() => void discover()}>
                    Scan again
                  </button>
                )}
              </>
            )}
            {(scanning || previewing) && !reset && (
              <button
                className="subtle"
                onClick={() => {
                  scan.current?.abort();
                }}
              >
                Cancel {previewing ? "preview" : "scan"}
              </button>
            )}
          </div>
          <dialog
            ref={resetDialog}
            className="reset-dialog"
            aria-labelledby="reset-title"
          >
            <h2 id="reset-title">Start over?</h2>
            <p>
              {analysisBusy || scanning || previewing
                ? "Current work will be cancelled and this folder cleared."
                : "This clears the selected folder and its draft results."}
            </p>
            <div className="folder-toolbar">
              <button autoFocus onClick={() => resetDialog.current?.close()}>
                Keep working
              </button>
              <button
                className="primary"
                onClick={() => {
                  resetDialog.current?.close();
                  beginReset();
                }}
              >
                Start over
              </button>
            </div>
          </dialog>
          {(status || reset) && (
            <p className="folder-status" role="status">
              {reset ? "Starting over…" : status}
            </p>
          )}
          {!scanning && listing?.files.length === 0 && (
            <p>No files discovered.</p>
          )}
          {scope && listing && listing.files.length > 0 && (
            <FileAnalysisPanel
              key={listingVersion}
              analysis={analysis}
              credentials={credentials}
              onConfigure={onConfigure}
              scope={scope.scopeId}
              files={listing.files}
              deviceBusy={selecting || reset || scanning || previewing}
              review={review}
              onReview={setReview}
              onBusy={setAnalysisBusy}
              resetSignal={resetController.signal}
              motionEnabled={motionEnabled}
              onAnalysisStarted={() => setDiscoveredCount(undefined)}
              discovering={discoveredCount !== undefined}
              onDiscover={() => setDiscoveredCount(listing.files.length)}
              folder={scope.label}
              onPreview={requestPreview}
              preview={preview}
              onPreviewLoad={() =>
                setStatus((current) =>
                  current === "Loading generated preview…" ? "" : current,
                )
              }
              onPreviewError={() => {
                discardPreview();
                setStatus("Could not display the generated preview.");
              }}
            />
          )}
        </div>
      )}
    </section>
  );
}
