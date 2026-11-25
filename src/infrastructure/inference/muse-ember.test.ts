import { describe, expect, it, vi } from "vitest";
import fixtures from "../../../fixtures/inference-diagnostic.json";
import { diagnosticInput } from "../../features/inference/application/diagnostic-input";
import {
  createMuseEmber,
  interpretResponse,
  makePayload,
  normalizeUsage,
} from "./muse-ember";
import { estimateEmberCost } from "./muse-pricing";

const model = "muse-ember-1.0";
const metrics = { provider: "Meta Model API", model, elapsedMs: 0 };
const value = {
  summary: "A sample",
  category: "document",
  tags: [],
  uncertainty: [],
};
const usage = {
  input_tokens: 100,
  output_tokens: 30,
  total_tokens: 130,
  input_tokens_details: { cached_tokens: 80 },
  output_tokens_details: { reasoning_tokens: 15 },
};
const message = (content: unknown, phase = "final_answer") => ({
  type: "message",
  role: "assistant",
  status: "completed",
  phase,
  content,
});
const output = (text: string) => message([{ type: "output_text", text }]);
const response = (fields: object) =>
  interpretResponse(
    JSON.stringify({
      model,
      status: "completed",
      output: [],
      usage,
      ...fields,
    }),
    metrics,
  );

describe("Muse Ember contract", () => {
  it("matches the native diagnostic schema and puts variable content after stable instructions", () => {
    const text = makePayload(diagnosticInput("text"));
    const image = makePayload(diagnosticInput("image"));
    expect(text.text.format.schema).toEqual(fixtures.schema);
    expect(text).toMatchObject({
      model,
      reasoning: { effort: "minimal" },
      max_output_tokens: 512,
      store: false,
      stream: false,
      background: false,
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: fixtures.text }],
        },
      ],
    });
    expect(image.text).toEqual(text.text);
    expect(image.instructions).toBe(text.instructions);
    expect(image.input[0].content[1]).toEqual({
      type: "input_image",
      image_url: `data:image/png;base64,${fixtures.png}`,
    });
  });

  it("extracts final assistant output and leaves reasoning and commentary alone", () => {
    expect(
      response({
        output: [
          { type: "reasoning", summary: [{ text: "ignore" }] },
          message([{ type: "output_text", text: "ignore" }], "commentary"),
          output(JSON.stringify(value)),
        ],
      }),
    ).toMatchObject({
      ok: true,
      value,
      metrics: { cost: { nanodollars: 17_320 } },
    });
  });

  it.each([
    [{ status: "failed" }, "providerFailed"],
    [{ status: "incomplete" }, "incomplete"],
    [
      {
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
      },
      "outputExhausted",
    ],
    [
      { output: [message([{ type: "refusal", refusal: "ignored" }])] },
      "refused",
    ],
    [{ output: [] }, "missingOutput"],
    [{ output: [output("{")] }, "invalidJson"],
    [
      { output: [output(JSON.stringify({ ...value, extra: true }))] },
      "schemaMismatch",
    ],
    [
      {
        output: [
          output(JSON.stringify({ ...value, summary: "a".repeat(321) })),
        ],
      },
      "schemaMismatch",
    ],
    [{ output: [{ type: "web_search_call" }] }, "unexpectedOutput"],
  ])(
    "normalizes raw response outcomes and preserves usage (%s)",
    (body, code) => {
      expect(response(body)).toMatchObject({
        ok: false,
        error: { code },
        metrics: { usage: { inputTokens: 100, reasoningTokens: 15 } },
      });
    },
  );

  it("passes cancellation through and keeps failures without usage unreconciled", async () => {
    const send = vi.fn(async () => ({
      ok: false as const,
      error: { code: "timeout" as const },
    }));
    const signal = new AbortController().signal;
    const outcome = await createMuseEmber(send).infer(
      diagnosticInput("text"),
      signal,
    );
    expect(send).toHaveBeenCalledExactlyOnceWith(expect.any(String), signal);
    expect(outcome).toMatchObject({ ok: false, error: { code: "timeout" } });
    expect(outcome.metrics.cost).toBeUndefined();
  });
});

describe("Ember usage accounting", () => {
  it("uses the full-input pricing tier and estimates absent cache details", () => {
    expect(
      estimateEmberCost({
        inputTokens: 200_000,
        outputTokens: 1,
        cachedInputTokens: 0,
      }),
    ).toEqual({
      currency: "USD",
      nanodollars: 20_000_500,
      upperEstimate: false,
    });
    expect(
      estimateEmberCost({ inputTokens: 200_001, outputTokens: 1 }),
    ).toEqual({
      currency: "USD",
      nanodollars: 60_001_800,
      upperEstimate: true,
    });
  });

  it("rejects missing or inconsistent token counts", () => {
    expect(normalizeUsage(undefined)).toBeUndefined();
    expect(normalizeUsage({ ...usage, total_tokens: 129 })).toBeUndefined();
    expect(
      normalizeUsage({
        ...usage,
        input_tokens_details: { cached_tokens: 101 },
      }),
    ).toBeUndefined();
    expect(
      normalizeUsage({
        ...usage,
        output_tokens_details: { reasoning_tokens: 31 },
      }),
    ).toBeUndefined();
    expect(normalizeUsage({ ...usage, output_tokens: -1 })).toBeUndefined();
  });
});
