import { useRef, useState } from "react";
import type { DeviceScope } from "../application/contracts";
import type { DeviceAdapter } from "../application/device";

export function DiscoveryScreen({ device }: { device: DeviceAdapter }) {
  const [scope, setScope] = useState<DeviceScope>();
  const [selecting, setSelecting] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [status, setStatus] = useState("");
  const revision = useRef(0);

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
      setScope(result.value.scope);
    } else {
      setStatus("Folder selection cancelled.");
    }
  }

  async function clearFolder() {
    if (!scope) return;
    const request = ++revision.current;
    setClearing(true);
    const result = await device.clearScope(scope.scopeId);
    setClearing(false);
    if (request !== revision.current) return;
    if (result.ok || result.error === "scopeInactive") {
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
      <button disabled={selecting || clearing} onClick={selectFolder}>
        {selecting ? "Selecting folder…" : "Select folder"}
      </button>
      <button disabled={!scope || clearing || selecting} onClick={clearFolder}>
        Clear
      </button>
      <p role="status">{status}</p>
    </section>
  );
}
