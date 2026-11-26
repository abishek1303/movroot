import type { MotionSignal } from "../../../components/motion/signals";
import { categoryForResult } from "../application/preview";
import type { FileProgress } from "../application/workflow";

export function analysisMotionSignal(
  progress: FileProgress,
): MotionSignal | undefined {
  switch (progress.state) {
    case "queued":
      return;
    case "analyzing":
      return { kind: "processing" };
    case "cancelled":
      return { kind: "cancelled" };
    case "skipped":
      return { kind: "skipped" };
    case "finished": {
      const attempt = progress.attempt;
      if ("error" in attempt)
        return {
          kind: attempt.error.code === "cancelled" ? "cancelled" : "failed",
        };
      const category = categoryForResult(attempt.result);
      return category
        ? { kind: "classified", category }
        : { kind: "uncertain" };
    }
  }
}
