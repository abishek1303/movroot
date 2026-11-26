import type {
  DeviceError,
  FileId,
  ScopeId,
} from "../../discovery/application/contracts";
import type {
  Failure,
  InferenceMetrics,
} from "../../inference/application/contracts";
import type {
  ImageMode,
  Manifest,
  Ready,
  SemanticFileAnalysis,
} from "./contracts";

export const fileAnalysisPolicy = {
  selection: 5,
  reserve: 2_912_000,
  pdfReserve: 6_000_000,
  defaultBudget: 10_000_000,
};

export type Attempt = {
  dispatch: "local" | "dispatched" | "ambiguous";
  metrics?: InferenceMetrics;
} & ({ result: SemanticFileAnalysis } | { error: Failure });

export interface FileAnalysisPort {
  prepare(
    scope: ScopeId,
    files: FileId[],
    signal: AbortSignal,
    imageMode?: ImageMode,
  ): Promise<{ manifest: Manifest } | { error: DeviceError }>;
  approve(plan: string): Promise<boolean>;
  discard(plan: string): Promise<void>;
  infer(plan: string, file: FileId, signal: AbortSignal): Promise<Attempt>;
}

export type FileProgress =
  | { state: "queued" | "analyzing" | "skipped" | "cancelled" }
  | { state: "finished"; attempt: Attempt };

export function createFileAnalysis(port: FileAnalysisPort) {
  let totals = {
    input: 0,
    output: 0,
    cached: 0,
    reasoning: 0,
    estimated: 0,
    reserved: 0,
    inFlight: 0,
    unresolved: 0,
    ambiguous: 0,
    upperEstimate: false,
  };
  let active = false;
  return {
    port,
    usage: () => totals,
    async run(
      plan: string,
      items: Ready[],
      budget: number,
      signal: AbortSignal,
      update: (file: FileId, progress: FileProgress) => void,
    ) {
      if (active) return "Analysis is already running.";
      active = true;
      let stop = "";
      const discard = () => {
        void port.discard(plan);
      };
      signal.addEventListener("abort", discard, { once: true });
      try {
        for (const item of items) {
          if (signal.aborted || stop) {
            update(item.fileId, {
              state: signal.aborted ? "cancelled" : "skipped",
            });
            continue;
          }
          const reserve =
            item.format === "pdf"
              ? fileAnalysisPolicy.pdfReserve
              : fileAnalysisPolicy.reserve;
          if (totals.estimated + totals.reserved + reserve > budget) {
            stop =
              totals.estimated >= budget
                ? "Reported estimated spending reached the session budget."
                : "Provisional reserves exceed the remaining session budget.";
            update(item.fileId, { state: "skipped" });
            continue;
          }
          totals = { ...totals, inFlight: reserve };
          update(item.fileId, { state: "analyzing" });
          const attempt = await port.infer(plan, item.fileId, signal);
          const usage = attempt.metrics?.usage;
          const cost = attempt.metrics?.cost;
          const unresolved = attempt.dispatch !== "local" && !cost;
          totals = {
            input: totals.input + (usage?.inputTokens ?? 0),
            output: totals.output + (usage?.outputTokens ?? 0),
            cached: totals.cached + (usage?.cachedInputTokens ?? 0),
            reasoning: totals.reasoning + (usage?.reasoningTokens ?? 0),
            estimated: totals.estimated + (cost?.nanodollars ?? 0),
            inFlight: 0,
            reserved: totals.reserved + (unresolved ? reserve : 0),
            unresolved:
              totals.unresolved +
              Number(unresolved && attempt.dispatch === "dispatched"),
            ambiguous:
              totals.ambiguous +
              Number(unresolved && attempt.dispatch === "ambiguous"),
            upperEstimate: totals.upperEstimate || Boolean(cost?.upperEstimate),
          };
          update(item.fileId, { state: "finished", attempt });
          if (
            "error" in attempt &&
            /^(rateLimited|authentication|credential.*|invalidCredential|budgetExceeded|staleSession|accessDenied|busy)$/.test(
              attempt.error.code,
            )
          ) {
            stop =
              attempt.error.code === "rateLimited"
                ? `Meta rate limit. Review a new batch after ${attempt.error.retryAfterSeconds ?? 30} seconds.`
                : `Remaining files skipped (${attempt.error.code}).`;
          }
        }
        return stop;
      } finally {
        active = false;
        totals = { ...totals, inFlight: 0 };
        signal.removeEventListener("abort", discard);
        await port.discard(plan);
      }
    },
  };
}

export type FileAnalysis = ReturnType<typeof createFileAnalysis>;
