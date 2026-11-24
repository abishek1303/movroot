import { DiscoveryScreen } from "../features/discovery/ui/DiscoveryScreen";
import { tauriDevice } from "../infrastructure/device/tauri-device";

export function App() {
  return (
    <main>
      <h1>Movroot</h1>
      <DiscoveryScreen device={tauriDevice} />
    </main>
  );
}
