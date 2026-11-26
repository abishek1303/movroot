import { DiscoveryMotion } from "../../../components/motion/DiscoveryMotion";
import type { FileAnalysis } from "../../file-analysis/application/workflow";
import { FileAnalysisPanel } from "../../file-analysis/ui/FileAnalysisPanel";
import { useEffect, useRef, useState } from "react";
import type { DeviceScope, Discovery, FileId } from "../application/contracts";
import type { DeviceAdapter } from "../application/device";

export function DiscoveryScreen({
  device,
  analysis,
  motionEnabled,
}: {
  device: DeviceAdapter;
  analysis: FileAnalysis;
  motionEnabled: boolean;
}) {
  const [scope, setScope] = useState<DeviceScope>();
  const [review, setReview] = useState(false);
  const [analysisBusy, setAnalysisBusy] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [status, setStatus] = useState("");
  const revision = useRef(0);
  const [listing, setListing] = useState<Discovery>();
  const [discoveredCount, setDiscoveredCount] = useState<number>();
  const [discoveryCancelling, setDiscoveryCancelling] = useState(false);
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
    setDiscoveredCount(undefined);
    setDiscoveryCancelling(false);
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
      setDiscoveredCount(result.value.files.length);
      const { status: outcome, files, unavailable } = result.value;
      setStatus(
        outcome === "complete"
          ? files.length
            ? `Found ${files.length} files.`
            : "No eligible files found."
          : `Scan ${outcome}. Showing ${files.length} files. ${unavailable} unavailable.`,
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

  async function clearFolder() {
    if (!scope) return;
    const request = ++revision.current;
    scan.current?.abort();
    discardPreview();
    setClearing(true);
    const result = await device.clearScope(scope.scopeId);
    setClearing(false);
    if (request !== revision.current) return;
    if (result.ok || result.error === "scopeInactive") {
      setListing(undefined);
      setScope(undefined);
      setDiscoveredCount(undefined);
      setReview(false);
      setStatus("");
    } else {
      setStatus("Could not clear the folder.");
    }
  }

  const step = review ? 2 : listing?.files.length ? 1 : 0;
  const busy = selecting || clearing || scanning || previewing || analysisBusy;
  return (
    <section className="organize" aria-label="Organize">
      <ol className="stepper" aria-label="Organize progress">
        {["Select folder", "Analyze", "Review changes"].map((label, index) => (
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
          <div className="folder-toolbar">
            <strong>{scope.label}</strong>
            <button disabled={busy} onClick={() => void selectFolder()}>
              Change folder
            </button>
            <button disabled={busy} onClick={() => void clearFolder()}>
              Clear
            </button>
            <button disabled={busy} onClick={() => void discover()}>
              {listing ? "Refresh" : "Retry discovery"}
            </button>
            {(scanning || previewing) && (
              <button
                onClick={() => {
                  if (scanning) setDiscoveryCancelling(true);
                  scan.current?.abort();
                }}
              >
                {previewing ? "Cancel preview" : "Cancel scan"}
              </button>
            )}
          </div>
          {scanning || (!review && discoveredCount !== undefined) ? (
            <DiscoveryMotion
              pending={scanning}
              count={discoveredCount}
              enabled={motionEnabled && !discoveryCancelling}
            />
          ) : null}
          <p role="status">{status}</p>
          {!review && listing && discoveredCount !== undefined && (
            <p>
              {listing.files.length} files found · {listing.examined} entries
              examined · {listing.unavailable} unavailable
            </p>
          )}
          {!review && preview && (
            <img
              src={preview.url}
              alt={`Thumbnail of ${preview.name}`}
              onLoad={() => setStatus("Preview ready.")}
              onError={() => {
                discardPreview();
                setStatus("Could not display the generated preview.");
              }}
            />
          )}
          {scope && listing && listing.files.length > 0 && (
            <FileAnalysisPanel
              key={listing.files[0].fileId}
              analysis={analysis}
              scope={scope.scopeId}
              files={listing.files}
              deviceBusy={selecting || clearing || scanning || previewing}
              review={review}
              onReview={setReview}
              onBusy={setAnalysisBusy}
              motionEnabled={motionEnabled}
              onAnalysisStarted={() => setDiscoveredCount(undefined)}
              folder={scope.label}
              onPreview={requestPreview}
              preview={preview}
              onPreviewLoad={() => setStatus("Preview ready.")}
              onPreviewError={() => {
                discardPreview();
                setStatus("Could not display the generated preview.");
              }}
            />
          )}
          {!review && listing && listing.files.length > 0 && (
            <details>
              <summary>Discovered files and thumbnails</summary>
              <table>
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Size in bytes</th>
                    <th>Preview</th>
                  </tr>
                </thead>
                <tbody>
                  {listing.files.map((file) => (
                    <tr key={file.fileId}>
                      <td>{file.displayName}</td>
                      <td>{file.sizeBytes ?? "Unknown"}</td>
                      <td>
                        {/^(png|jpe?g)$/i.test(file.extension ?? "") && (
                          <button
                            disabled={busy}
                            onClick={() =>
                              requestPreview(file.fileId, file.displayName)
                            }
                          >
                            Preview
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </details>
          )}
        </div>
      )}
    </section>
  );
}
