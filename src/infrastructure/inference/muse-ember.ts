import { z } from "zod";
import {
  analysisSchema,
  inferenceInputSchema,
  shapeSchema,
  usageSchema,
} from "../../features/inference/application/contracts";
import type {
  Failure,
  InferenceInput,
  InferenceMetrics,
  InferenceOutcome,
  Usage,
} from "../../features/inference/application/contracts";
import type { InferenceProvider } from "../../features/inference/application/provider";
import { emberPricing, estimateEmberCost } from "./muse-pricing";
import type { MuseTransport } from "./tauri-muse-transport";

import fixtures from "../../../fixtures/inference-diagnostic.json";

const diagnostic = {
  model: emberPricing.model,
  reasoning: "minimal",
  maxOutputTokens: 512,
  schemaName: fixtures.schemaName,
  instructions: fixtures.instructions,
} as const;
const { $schema: _dialect, ...wireSchema } = z.toJSONSchema(shapeSchema);
void _dialect;

const envelopeSchema = z.object({
  status: z.enum([
    "completed",
    "failed",
    "incomplete",
    "cancelled",
    "queued",
    "in_progress",
  ]),
  id: z.unknown().optional(),
  model: z.literal(diagnostic.model),
  output: z.array(z.unknown()).max(64),
  usage: z.unknown().optional(),
  incomplete_details: z.object({ reason: z.string() }).nullish(),
});
const wireUsageSchema = z.object({
  input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
  total_tokens: z.number().int().nonnegative().optional(),
  input_tokens_details: z
    .object({ cached_tokens: z.number().int().nonnegative().nullish() })
    .nullish(),
  output_tokens_details: z
    .object({ reasoning_tokens: z.number().int().nonnegative().nullish() })
    .nullish(),
});
const itemSchema = z.object({ type: z.string() });
const messageSchema = z.object({
  role: z.literal("assistant"),
  phase: z.enum(["commentary", "final_answer"]).nullish(),
  status: z.enum(["completed", "incomplete", "in_progress"]).optional(),
  content: z
    .array(
      z.discriminatedUnion("type", [
        z.object({ type: z.literal("output_text"), text: z.string() }),
        z.object({ type: z.literal("refusal"), refusal: z.string() }),
      ]),
    )
    .max(32),
});

export function normalizeUsage(raw: unknown): Usage | undefined {
  const wire = wireUsageSchema.safeParse(raw);
  if (!wire.success) return undefined;
  const value = wire.data;
  if (value.input_tokens + value.output_tokens > 1_048_576) return undefined;
  if (
    value.total_tokens !== undefined &&
    value.total_tokens !== value.input_tokens + value.output_tokens
  )
    return undefined;
  const usage = usageSchema.safeParse({
    inputTokens: value.input_tokens,
    outputTokens: value.output_tokens,
    cachedInputTokens: value.input_tokens_details?.cached_tokens ?? undefined,
    reasoningTokens: value.output_tokens_details?.reasoning_tokens ?? undefined,
  });
  return usage.success ? usage.data : undefined;
}

function imageUrl(input: Extract<InferenceInput, { kind: "image" }>): string {
  let binary = "";
  for (const byte of input.bytes) binary += String.fromCharCode(byte);
  return `data:${input.mime};base64,${btoa(binary)}`;
}

export function makePayload(input: InferenceInput) {
  const content =
    input.kind === "text"
      ? [{ type: "input_text", text: input.text }]
      : [
          { type: "input_text", text: fixtures.imagePrompt },
          { type: "input_image", image_url: imageUrl(input) },
        ];
  return {
    model: diagnostic.model,
    instructions: diagnostic.instructions,
    text: {
      format: {
        type: "json_schema",
        name: diagnostic.schemaName,
        strict: true,
        schema: wireSchema,
      },
    },
    reasoning: { effort: diagnostic.reasoning },
    max_output_tokens: diagnostic.maxOutputTokens,
    store: false,
    stream: false,
    background: false,
    input: [{ type: "message", role: "user", content }],
  };
}

function fail(
  metrics: InferenceMetrics,
  code: Failure["code"],
): { ok: false; error: Failure; metrics: InferenceMetrics } {
  return { ok: false, error: { code }, metrics };
}

export function interpretResponse(
  body: string,
  initial: InferenceMetrics,
): InferenceOutcome {
  return interpretStructuredResponse(body, initial, analysisSchema);
}

export function interpretStructuredResponse<T extends object>(
  body: string,
  initial: InferenceMetrics,
  schema: z.ZodType<T>,
):
  | { ok: true; value: T; metrics: InferenceMetrics }
  | { ok: false; error: Failure; metrics: InferenceMetrics } {
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    return fail(initial, "invalidResponse");
  }
  const envelope = envelopeSchema.safeParse(raw);
  if (!envelope.success) {
    const accounting = envelopeSchema
      .pick({ model: true, usage: true })
      .safeParse(raw);
    const usage = accounting.success
      ? normalizeUsage(accounting.data.usage)
      : undefined;
    return fail(
      { ...initial, usage, cost: usage && estimateEmberCost(usage) },
      "invalidResponse",
    );
  }
  const response = envelope.data;
  const usage = normalizeUsage(response.usage);
  const metrics = {
    ...initial,
    usage,
    cost: usage ? estimateEmberCost(usage) : undefined,
    diagnostics: {
      ...initial.diagnostics,
      providerStatus: response.status,
      providerResponseId:
        typeof response.id === "string" &&
        /^resp_[A-Za-z0-9_-]{1,96}$/.test(response.id)
          ? response.id
          : undefined,
    },
  };
  if (response.status === "failed") return fail(metrics, "providerFailed");
  if (response.status === "cancelled") return fail(metrics, "cancelled");
  if (response.status === "incomplete") {
    return fail(
      metrics,
      response.incomplete_details?.reason === "max_output_tokens"
        ? "outputExhausted"
        : "incomplete",
    );
  }
  if (response.status !== "completed") return fail(metrics, "invalidResponse");
  let output = "";
  for (const item of response.output) {
    const kind = itemSchema.safeParse(item);
    if (!kind.success) return fail(metrics, "unexpectedOutput");
    if (kind.data.type === "reasoning") continue;
    if (kind.data.type !== "message") return fail(metrics, "unexpectedOutput");
    const message = messageSchema.safeParse(item);
    if (!message.success) return fail(metrics, "unexpectedOutput");
    if (message.data.content.some((part) => part.type === "refusal"))
      return fail(metrics, "refused");
    if (message.data.phase === "commentary") continue;
    if (message.data.status && message.data.status !== "completed")
      return fail(metrics, "incomplete");
    for (const part of message.data.content) {
      if (part.type === "output_text") output += part.text;
    }
  }
  if (!output.trim()) return fail(metrics, "missingOutput");
  let value: unknown;
  try {
    value = JSON.parse(output);
  } catch {
    return fail(metrics, "invalidJson");
  }
  const analysis = schema.safeParse(value);
  return analysis.success
    ? {
        ok: true,
        value: analysis.data,
        metrics: {
          ...metrics,
          diagnostics: {
            ...metrics.diagnostics,
            normalizedFields: Object.keys(analysis.data).filter(
              (key) =>
                JSON.stringify(
                  (analysis.data as Record<string, unknown>)[key],
                ) !== JSON.stringify((value as Record<string, unknown>)[key]),
            ),
          },
        },
      }
    : fail(
        {
          ...metrics,
          diagnostics: {
            ...metrics.diagnostics,
            validationIssues: analysis.error.issues
              .slice(0, 5)
              .map(({ path, code }) => {
                const field = path[0];
                return typeof field === "string" &&
                  /^[a-zA-Z]{1,32}$/.test(field)
                  ? `${field}: ${code}`
                  : code;
              }),
          },
        },
        "schemaMismatch",
      );
}

export function createMuseEmber(send: MuseTransport): InferenceProvider {
  let correlation = 0;
  return {
    async infer(input, signal) {
      const started = performance.now();
      const initial: InferenceMetrics = {
        provider: "Meta Model API",
        model: diagnostic.model,
        elapsedMs: 0,
        diagnostics: {
          correlationId: String(++correlation),
          modality: input.kind,
          schemaVersion: diagnostic.schemaName,
          reasoningEffort: diagnostic.reasoning,
          outputTokenLimit: diagnostic.maxOutputTokens,
        },
      };
      const parsed = inferenceInputSchema.safeParse(input);
      if (!parsed.success) return fail(initial, "invalidRequest");
      if (
        parsed.data.kind === "image" &&
        parsed.data.bytes.byteLength > 64 * 1024
      ) {
        return fail(initial, "requestLimit");
      }
      if (
        parsed.data.kind === "text" &&
        new TextEncoder().encode(parsed.data.text).byteLength > 4096
      ) {
        return fail(initial, "requestLimit");
      }
      const body = JSON.stringify(makePayload(parsed.data));
      const payloadBytes = new TextEncoder().encode(body).byteLength;
      const reply = await send(body, signal);
      const metrics = {
        ...initial,
        elapsedMs: Math.round(performance.now() - started),
        diagnostics: {
          ...initial.diagnostics,
          payloadBytes,
          httpStatus:
            (reply.ok ? reply.value.httpStatus : reply.error.httpStatus) ??
            undefined,
        },
      };
      return reply.ok
        ? interpretResponse(reply.value.body, metrics)
        : { ok: false, error: reply.error, metrics };
    },
  };
}
