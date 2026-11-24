import { useEffect, useRef, useState } from "react";
import type { DeviceScope, Discovery, FileId } from "../application/contracts";
import type { DeviceAdapter } from "../application/device";

export function DiscoveryScreen({ device }: { device: DeviceAdapter }) {
  const [scope, setScope] = useState<DeviceScope>();
  const [selecting, setSelecting] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [status, setStatus] = useState("");
  const revision = useRef(0);
  const [listing, setListing] = useState<Discovery>();
  const [scanning, setScanning] = useState(false);
  const scan = useRef<AbortController | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [preview, setPreview] = useState<{ url: string; name: string }>();
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
      setPreview({ url, name });
      setStatus("Loading generated preview…");
    }
  }

  async function discover() {
    if (!scope || scan.current) return;
    const request = ++revision.current;
    const controller = new AbortController();
    scan.current = controller;
    discardPreview();
    setScanning(true);
    setStatus("Discovering files…");
    const result = await device.discover(scope.scopeId, controller.signal);
    scan.current = null;
    setScanning(false);
    if (request !== revision.current) return;
    if (
      controller.signal.aborted ||
      (result.ok && result.value.status === "cancelled")
    ) {
      if (result.ok && result.value.status !== "cancelled")
        setListing(undefined);
      setStatus(
        "Discovery cancelled. Any displayed files are from the previous scan.",
      );
    } else if (!result.ok) {
      setStatus(
        "Discovery failed. Any displayed files are from the previous scan.",
      );
    } else {
      setListing(result.value);
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
      setScope(result.value.scope);
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
      setStatus("Folder cleared.");
    } else {
      setStatus("Could not clear the folder.");
    }
  }

  return (
    <section aria-label="Device access">
      <p>
        {scope ? `Authorized folder: ${scope.label}` : "No folder authorized."}
      </p>
      <button
        disabled={selecting || clearing || scanning || previewing}
        onClick={selectFolder}
      >
        {selecting ? "Selecting folder…" : "Select folder"}
      </button>
      <button disabled={!scope || clearing || selecting} onClick={clearFolder}>
        Clear
      </button>
      <button
        disabled={!scope || selecting || clearing || scanning || previewing}
        onClick={discover}
      >
        {listing ? "Refresh" : "Discover files"}
      </button>
      <button
        disabled={!scanning && !previewing}
        onClick={() => scan.current?.abort()}
      >
        {previewing ? "Cancel preview" : "Cancel scan"}
      </button>
      <p role="status">{status}</p>
      {preview && (
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
      {listing && listing.files.length > 0 && (
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
                      disabled={selecting || clearing || scanning || previewing}
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
      )}
    </section>
  );
}
