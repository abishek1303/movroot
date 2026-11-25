import type {
  CostEstimate,
  Usage,
} from "../../features/inference/application/contracts";

export const emberPricing = {
  model: "muse-ember-1.0",
  source: "https://dev.meta.ai/docs/pricing-rate-limits#muse-ember-pricing",
  checkedOn: "2026-11-24",
  currency: "USD",
  longContextAbove: 200_000,
  standard: { cached: 4, input: 100, output: 500 },
  long: { cached: 12, input: 300, output: 1500 },
} as const;

export function estimateEmberCost(usage: Usage): CostEstimate | undefined {
  const rates =
    usage.inputTokens > emberPricing.longContextAbove
      ? emberPricing.long
      : emberPricing.standard;
  const cached = usage.cachedInputTokens ?? 0;
  const nanodollars =
    cached * rates.cached +
    (usage.inputTokens - cached) * rates.input +
    usage.outputTokens * rates.output;
  if (!Number.isSafeInteger(nanodollars) || nanodollars < 0) return undefined;
  return {
    currency: emberPricing.currency,
    nanodollars,
    upperEstimate:
      usage.cachedInputTokens === undefined && usage.inputTokens > 0,
  };
}
