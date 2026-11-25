import { expect, it } from "vitest";
import type { InferenceOutcome } from "./contracts";
import { createInferenceSession } from "./session";

const input = { kind: "text", text: "Synthetic fixture" } as const;
const reply: InferenceOutcome = {
  ok: true,
  value: {
    summary: "Fixture",
    category: "document",
    tags: [],
    uncertainty: [],
  },
  metrics: {
    provider: "fixture",
    model: "fixture",
    elapsedMs: 0,
    usage: { inputTokens: 10, outputTokens: 10 },
    cost: { currency: "USD", nanodollars: 6000, upperEstimate: false },
  },
};

it("keeps cancellation unreconciled and discards a late success", async () => {
  const session = createInferenceSession({ infer: async () => reply });
  const active = session.run(input);
  const concurrent = session.run(input);
  session.cancel();
  expect(await concurrent).toBeUndefined();
  expect(await active).toMatchObject({
    outcome: { ok: false, error: { code: "cancelled" } },
    usage: { pricedResponses: 0, unreconciledAttempts: 1 },
  });
  expect(await session.run(input)).toMatchObject({
    outcome: { ok: true },
    usage: { pricedResponses: 1, unreconciledAttempts: 1 },
  });
});

it("ignores results invalidated by a session change", async () => {
  const session = createInferenceSession({ infer: async () => reply });
  const active = session.run(input);
  session.invalidate();
  expect(await active).toBeUndefined();
});
