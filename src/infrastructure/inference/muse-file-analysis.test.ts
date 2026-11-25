import { expect, test, vi } from "vitest";
import { z } from "zod";
import config from "../../../fixtures/file-semantic-v1.json";
import {
  fileIdSchema,
  scopeIdSchema,
} from "../../features/discovery/application/contracts";
import {
  semanticAnalysis,
  semanticShape,
  suggestedName,
} from "../../features/file-analysis/application/contracts";
import { createFileAnalysis } from "../../features/file-analysis/application/workflow";
import type { FileAnalysisPort } from "../../features/file-analysis/application/workflow";
import { interpretStructuredResponse } from "./muse-ember";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const receipt = {
  presentation: "screenshot",
  semanticType: "purchase receipt",
  summary: "A grocery receipt.",
  observations: ["A grocery total is visible."],
  topic: "Grocery shopping",
  likelyPurpose: "Record an expense",
  tags: ["Groceries", "groceries"],
  entities: [],
  suggestedStem: " Grocery receipt ",
  sensitivity: [],
  uncertainty: [],
};
const first = fileIdSchema.parse("first");
const second = fileIdSchema.parse("second");
const third = fileIdSchema.parse("third");
const items = [first, second, third].map((fileId) => ({
  fileId,
  name: "receipt.PNG",
  extension: "PNG",
  format: "png" as const,
  status: "ready" as const,
  coverage: {
    kind: "image" as const,
    original: [100, 100] as [number, number],
    transmitted: [100, 100] as [number, number],
    resized: false,
    transmittedBytes: 120,
  },
}));

test("shares the exact semantic wire schema and normalizes filename proposals", () => {
  const [dialect, schema] = Object.entries(
    z.toJSONSchema(semanticShape),
  ).reduce<[unknown, Record<string, unknown>]>(
    (acc, [key, value]) => {
      if (key === "$schema") acc[0] = value;
      else acc[1][key] = value;
      return acc;
    },
    [undefined, {}],
  );
  expect(dialect).toBeDefined();
  expect(schema).toEqual(config.schema);
  const output = semanticAnalysis.parse(receipt);
  expect(output.presentation).toBe("screenshot");
  expect(output.semanticType).toBe("purchase receipt");
  expect(output.tags).toEqual(["groceries"]);
  expect(suggestedName(output.suggestedStem, items[0])).toBe(
    "Grocery receipt.PNG",
  );
  for (const suggestedStem of [
    "../file",
    "CON",
    "LPT²",
    "a.txt",
    "a\nb",
    "  ",
  ]) {
    expect(
      semanticAnalysis.parse({ ...receipt, suggestedStem }).suggestedStem,
    ).toBeNull();
  }
});

test("normalizes a bounded provider tag list to five displayed tags", () => {
  expect(
    semanticAnalysis.parse({
      ...receipt,
      tags: [
        "Apples",
        "apples",
        "Red",
        "Fruit",
        "Still life",
        "Table",
        "Studio",
      ],
    }).tags,
  ).toEqual(["apples", "red", "fruit", "still life", "table"]);
  expect(
    semanticAnalysis.safeParse({
      ...receipt,
      tags: Array.from({ length: 33 }, () => "tag"),
    }).success,
  ).toBe(false);
});

test("normalizes the longer prose and lists returned by the live text samples", () => {
  const value = semanticAnalysis.parse({
    ...receipt,
    summary: "Project notes and next steps. ".repeat(14),
    observations: Array.from({ length: 5 }, () =>
      "The field guide is designed for offline use. ".repeat(5),
    ),
    entities: [
      "Kestrel",
      "Map labels",
      "Field guide",
      "Specimen cards",
      "Prototype",
    ],
  });
  expect(value.summary.length).toBeLessThanOrEqual(240);
  expect(value.summary.endsWith("…")).toBe(true);
  expect(value.observations).toHaveLength(3);
  expect(
    value.observations.every((observation) => observation.length <= 100),
  ).toBe(true);
  expect(value.entities).toHaveLength(4);
  expect(
    semanticAnalysis.safeParse({ ...receipt, observations: [1] }).success,
  ).toBe(false);
});

test("preserves complete safety caveats and still rejects structural errors", () => {
  const uncertainty = [
    "Only the transmitted excerpt was available. " +
      "The remaining content was not reviewed. ".repeat(4).trim(),
    "The source does not name an author.",
    "The excerpt cannot establish the document date.",
    "Later sections may differ.",
  ];
  const raw = {
    ...receipt,
    uncertainty,
    sensitivity: ["financial", "health", "financial"],
    suggestedStem: "/".repeat(300),
  };
  const result = semanticAnalysis.parse(raw);
  expect(result.uncertainty).toEqual(uncertainty);
  expect(result.sensitivity).toEqual(["financial", "health"]);
  expect(result.suggestedStem).toBeNull();
  const missing = { ...receipt } as Partial<typeof receipt>;
  delete missing.summary;
  for (const invalid of [
    missing,
    { ...receipt, presentation: "invalid" },
    { ...receipt, tags: [7] },
    { ...receipt, sensitivity: ["invalid"] },
    { ...receipt, uncertainty: [null] },
    { ...receipt, suggestedStem: 42 },
  ]) {
    expect(semanticAnalysis.safeParse(invalid).success).toBe(false);
  }
});

test("fake workflow isolates failures, preserves usage on cancellation, and stops queued work", async () => {
  const controller = new AbortController();
  const manifest = { planId: "plan", items };
  const updates = vi.fn();
  const infer = vi
    .fn<FileAnalysisPort["infer"]>()
    .mockResolvedValueOnce({
      dispatch: "local",
      error: { code: "resourceChanged" },
    })
    .mockImplementationOnce(async () => {
      controller.abort();
      const result = interpretStructuredResponse(
        JSON.stringify({
          model: config.model,
          status: "completed",
          output: [
            {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "{}" }],
            },
          ],
          usage: { input_tokens: 100, output_tokens: 20 },
        }),
        { provider: "Meta Model API", model: config.model, elapsedMs: 5 },
        semanticAnalysis,
      );
      if (result.ok) throw new Error("unexpected successful analysis");
      return {
        dispatch: "dispatched",
        error: result.error,
        metrics: result.metrics,
      };
    });
  const port: FileAnalysisPort = {
    prepare: vi.fn(async () => ({ manifest })),
    approve: vi.fn(async () => true),
    discard: vi.fn(async () => {}),
    infer,
  };
  const analysis = createFileAnalysis(port);
  expect(
    await port.prepare(
      scopeIdSchema.parse("scope"),
      [first, second, third],
      controller.signal,
    ),
  ).toEqual({ manifest });
  expect(await port.approve(manifest.planId)).toBe(true);
  await analysis.run(
    manifest.planId,
    items,
    10_000_000,
    controller.signal,
    updates,
  );
  expect(infer).toHaveBeenCalledTimes(2);
  expect(analysis.usage()).toMatchObject({
    input: 100,
    output: 20,
    estimated: 20_000,
    reserved: 0,
    unresolved: 0,
  });
  expect(updates).toHaveBeenLastCalledWith(third, { state: "cancelled" });
});

test("holds ambiguous and dispatched reserves separately from priced usage", async () => {
  const port: FileAnalysisPort = {
    prepare: vi.fn(),
    approve: vi.fn(),
    discard: vi.fn(),
    infer: vi
      .fn<FileAnalysisPort["infer"]>()
      .mockResolvedValueOnce({
        dispatch: "ambiguous",
        error: { code: "transportError" },
      })
      .mockResolvedValueOnce({
        dispatch: "dispatched",
        error: { code: "timeout" },
      }),
  };
  const analysis = createFileAnalysis(port);
  const message = await analysis.run(
    "plan",
    items,
    7_000_000,
    new AbortController().signal,
    vi.fn(),
  );
  expect(message).toMatch(/Provisional reserves/);
  expect(analysis.usage()).toMatchObject({
    estimated: 0,
    reserved: 5_824_000,
    unresolved: 1,
    ambiguous: 1,
  });
});

test("fake IPC takes a scoped file from local review to a priced semantic result", async () => {
  const { invoke } = await import("@tauri-apps/api/core");
  const { tauriDevice } = await import("../device/tauri-device");
  const { createMuseConnection } = await import("./tauri-muse-transport");
  const { createMuseFileAnalysis } = await import("./muse-file-analysis");
  const mocked = vi.mocked(invoke);
  const scopeId = "scope-synthetic";
  const sessionId = "c7b199e7-e40b-4159-b13d-b10979ad60cf";
  const planId = "e2369bca-afe4-4e50-835c-efdeb4c87848";
  let approved = false;
  mocked.mockImplementation(async (command, args) => {
    switch (command) {
      case "select_device_scope":
        return {
          status: "selected",
          scope: {
            scopeId,
            label: "Fixture",
            capabilities: ["read", "discover"],
          },
        };
      case "muse_ember_key_status":
        return { sessionId, source: "environment", remainingDispatches: 20 };
      case "prepare_file_analysis":
        expect(args).toEqual({
          request: { scopeId, sessionId, requestId: 1, fileIds: [first] },
        });
        return { planId, items: [items[0]] };
      case "approve_file_analysis":
        approved = true;
        return true;
      case "discard_file_analysis":
        return undefined;
      case "infer_muse_ember_file":
        expect(approved).toBe(true);
        expect(args).toEqual({
          request: { sessionId, requestId: 1, planId, fileId: first },
        });
        return {
          dispatched: true,
          error: null,
          reply: {
            httpStatus: 200,
            body: JSON.stringify({
              model: config.model,
              status: "completed",
              usage: {
                input_tokens: 200,
                output_tokens: 40,
                output_tokens_details: { reasoning_tokens: 10 },
              },
              output: [
                {
                  type: "message",
                  role: "assistant",
                  content: [
                    { type: "output_text", text: JSON.stringify(receipt) },
                  ],
                },
              ],
            }),
          },
        };
      default:
        throw new Error(command);
    }
  });
  const selection = await tauriDevice.selectScope();
  expect(selection.ok).toBe(true);
  const port = createMuseFileAnalysis(createMuseConnection());
  const analysis = createFileAnalysis(port);
  const signal = new AbortController().signal;
  const prepared = await port.prepare(
    scopeIdSchema.parse(scopeId),
    [first],
    signal,
  );
  expect(prepared).toEqual({ manifest: { planId, items: [items[0]] } });
  expect(mocked.mock.calls.map(([command]) => command)).not.toContain(
    "infer_muse_ember_file",
  );
  await port.approve(planId);
  const progress = vi.fn();
  await analysis.run(planId, [items[0]], 10_000_000, signal, progress);
  expect(progress).toHaveBeenLastCalledWith(
    first,
    expect.objectContaining({
      state: "finished",
      attempt: expect.objectContaining({
        result: expect.objectContaining({ semanticType: "purchase receipt" }),
      }),
    }),
  );
  expect(analysis.usage()).toMatchObject({
    estimated: 40_000,
    reasoning: 10,
    reserved: 0,
  });
});
