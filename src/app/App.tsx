import { createFileAnalysis } from "../features/file-analysis/application/workflow";
import { createMuseFileAnalysis } from "../infrastructure/inference/muse-file-analysis";
import { InferencePanel } from "../features/inference/ui/InferencePanel";
import { createMuseEmber } from "../infrastructure/inference/muse-ember";
import { createMuseConnection } from "../infrastructure/inference/tauri-muse-transport";
import { DiscoveryScreen } from "../features/discovery/ui/DiscoveryScreen";
import { tauriDevice } from "../infrastructure/device/tauri-device";

const muse = createMuseConnection();
const fileAnalysis = createFileAnalysis(createMuseFileAnalysis(muse));
const provider = createMuseEmber(muse.send);

export function App() {
  return (
    <main>
      <h1>Movroot</h1>
      <DiscoveryScreen device={tauriDevice} analysis={fileAnalysis} />
      <InferencePanel provider={provider} credentials={muse.credentials} />
    </main>
  );
}
