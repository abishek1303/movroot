import { z } from "zod";

export const inferenceInputSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("text"), text: z.string().trim().min(1) }),
  z.strictObject({
    kind: z.literal("image"),
    mime: z.enum(["image/png", "image/jpeg"]),
    bytes: z.instanceof(Uint8Array).refine((bytes) => bytes.byteLength > 0),
  }),
]);

export const categorySchema = z.enum([
  "document",
  "photo",
  "illustration",
  "screenshot",
  "other",
]);

// Keep the wire schema in Meta's strict subset. Feature limits are applied locally below.
export const shapeSchema = z.strictObject({
  summary: z.string(),
  category: categorySchema,
  tags: z.array(z.string()),
  uncertainty: z.array(z.string()),
});

export const analysisSchema = shapeSchema.extend({
  summary: z.string().trim().min(1).max(320),
  tags: z.array(z.string().trim().min(1).max(32)).max(5),
  uncertainty: z.array(z.string().trim().min(1).max(120)).max(4),
});

const count = z.number().int().nonnegative();
export const usageSchema = z
  .strictObject({
    inputTokens: count,
    outputTokens: count,
    cachedInputTokens: count.optional(),
    reasoningTokens: count.optional(),
  })
  .refine(
    (usage) =>
      (usage.cachedInputTokens ?? 0) <= usage.inputTokens &&
      (usage.reasoningTokens ?? 0) <= usage.outputTokens &&
      Number.isSafeInteger(usage.inputTokens + usage.outputTokens),
  );

export const failureCodeSchema = z.enum([
  "invalidCredential",
  "credentialStore",
  "credentialConfiguration",
  "credentialMissing",
  "busy",
  "staleSession",
  "resourceChanged",
  "invalidRequest",
  "requestLimit",
  "responseLimit",
  "budgetExceeded",
  "cancelled",
  "timeout",
  "network",
  "requestRejected",
  "authentication",
  "accessDenied",
  "rateLimited",
  "providerUnavailable",
  "httpFailure",
  "invalidResponse",
  "providerFailed",
  "incomplete",
  "outputExhausted",
  "refused",
  "missingOutput",
  "invalidJson",
  "schemaMismatch",
  "unexpectedOutput",
  "transportError",
]);
export const failureSchema = z.strictObject({
  code: failureCodeSchema,
  httpStatus: z.number().int().min(100).max(599).nullish(),
  retryAfterSeconds: z.number().int().min(0).max(3600).nullish(),
});
export type Failure = z.infer<typeof failureSchema>;
export type InferenceInput = z.infer<typeof inferenceInputSchema>;
export type Analysis = z.infer<typeof analysisSchema>;
export type Usage = z.infer<typeof usageSchema>;
export type CostEstimate = {
  currency: "USD";
  nanodollars: number;
  upperEstimate: boolean;
};

export interface InferenceMetrics {
  provider: string;
  model: string;
  elapsedMs: number;
  usage?: Usage;
  cost?: CostEstimate;
  diagnostics?: {
    correlationId?: string;
    modality?: InferenceInput["kind"];
    schemaVersion?: string;
    reasoningEffort?: string;
    outputTokenLimit?: number;
    payloadBytes?: number;
    httpStatus?: number;
    providerStatus?: string;
    providerResponseId?: string;
    validationIssues?: string[];
    normalizedFields?: string[];
  };
}
export type InferenceOutcome =
  | { ok: true; value: Analysis; metrics: InferenceMetrics }
  | { ok: false; error: Failure; metrics: InferenceMetrics };
