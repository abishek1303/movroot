import type {
  InferenceInput,
  InferenceMetrics,
  InferenceOutcome,
} from "./contracts";
import type { InferenceProvider } from "./provider";

export const ESTIMATED_SESSION_LIMIT = 10_000_000; // USD $0.01 in nanodollars

export interface SessionUsage {
  inputTokens: number;
  outputTokens: number;
  estimatedNanodollars: number;
  usageResponses: number;
  pricedResponses: number;
  unreconciledAttempts: number;
  includesUpperEstimate: boolean;
}

export const emptyUsage: SessionUsage = {
  inputTokens: 0,
  outputTokens: 0,
  estimatedNanodollars: 0,
  usageResponses: 0,
  pricedResponses: 0,
  unreconciledAttempts: 0,
  includesUpperEstimate: false,
};

export function reconcile(
  previous: SessionUsage,
  metrics: InferenceMetrics,
): SessionUsage {
  return {
    inputTokens: previous.inputTokens + (metrics.usage?.inputTokens ?? 0),
    outputTokens: previous.outputTokens + (metrics.usage?.outputTokens ?? 0),
    estimatedNanodollars:
      previous.estimatedNanodollars + (metrics.cost?.nanodollars ?? 0),
    usageResponses:
      previous.usageResponses + Number(metrics.usage !== undefined),
    pricedResponses:
      previous.pricedResponses + Number(metrics.cost !== undefined),
    unreconciledAttempts:
      previous.unreconciledAttempts + Number(metrics.cost === undefined),
    includesUpperEstimate:
      previous.includesUpperEstimate || Boolean(metrics.cost?.upperEstimate),
  };
}

export function createInferenceSession(provider: InferenceProvider) {
  let usage = emptyUsage;
  let active: AbortController | undefined;
  let revision = 0;

  return {
    async run(
      input: InferenceInput,
    ): Promise<{ outcome: InferenceOutcome; usage: SessionUsage } | undefined> {
      if (active || usage.estimatedNanodollars >= ESTIMATED_SESSION_LIMIT)
        return undefined;
      const abort = new AbortController();
      const current = ++revision;
      active = abort;
      try {
        const response = await provider.infer(input, abort.signal);
        if (current !== revision) return undefined;
        const outcome: InferenceOutcome = abort.signal.aborted
          ? {
              ok: false,
              error: { code: "cancelled" },
              metrics: {
                ...response.metrics,
                usage: undefined,
                cost: undefined,
              },
            }
          : response;
        usage = reconcile(usage, outcome.metrics);
        return { outcome, usage };
      } finally {
        if (active === abort) active = undefined;
      }
    },
    cancel() {
      active?.abort();
    },
    invalidate() {
      revision += 1;
      active?.abort();
    },
  };
}
