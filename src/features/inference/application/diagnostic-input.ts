import type { InferenceInput } from "./contracts";

import fixtures from "../../../../fixtures/inference-diagnostic.json";

export const diagnosticText = fixtures.text;

export function diagnosticInput(kind: "text" | "image"): InferenceInput {
  return kind === "text"
    ? { kind, text: diagnosticText }
    : {
        kind,
        mime: "image/png",
        bytes: Uint8Array.from(atob(fixtures.png), (char) =>
          char.charCodeAt(0),
        ),
      };
}
