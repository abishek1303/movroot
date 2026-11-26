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
    orientationApplied: false,
    sourceBytes: 140,
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

test("normalizes a bounded provider tag list without discarding distinct tags", () => {
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
  ).toEqual(["apples", "red", "fruit", "still life", "table", "studio"]);
  expect(
    semanticAnalysis.safeParse({
      ...receipt,
      tags: Array.from({ length: 33 }, () => "tag"),
    }).success,
  ).toBe(false);
});

test("preserves semantic prose and lists that exceed presentation preview lengths", () => {
  const prose = "Grounded semantic detail. ".repeat(20).trim();
  const list = Array.from({ length: 12 }, (_, index) => `${index} ${prose}`);
  const payload = {
    ...receipt,
    semanticType: prose,
    summary: prose,
    topic: prose,
    likelyPurpose: prose,
    observations: list,
    tags: list,
    entities: list,
    uncertainty: list,
  };
  expect(semanticAnalysis.parse(payload)).toEqual({
    ...payload,
    tags: list.map((tag) => tag.toLowerCase()),
    suggestedStem: "Grocery receipt",
  });
});

test("reports processing limits for all prose fields and lists", () => {
  const oversized = "a".repeat(2049);
  for (const key of ["semanticType", "summary", "topic", "likelyPurpose"]) {
    const result = semanticAnalysis.safeParse({ ...receipt, [key]: oversized });
    expect(result.error?.issues[0]).toMatchObject({
      path: [key],
      code: "too_big",
    });
  }
  for (const key of [
    "observations",
    "tags",
    "entities",
    "uncertainty",
    "sensitivity",
  ]) {
    const result = semanticAnalysis.safeParse({
      ...receipt,
      [key]: Array(33).fill(key === "sensitivity" ? "financial" : "detail"),
    });
    expect(result.error?.issues[0]).toMatchObject({
      path: [key],
      code: "too_big",
    });
  }
  for (const key of ["observations", "tags", "entities", "uncertainty"]) {
    const result = semanticAnalysis.safeParse({
      ...receipt,
      [key]: [oversized],
    });
    expect(result.error?.issues[0]).toMatchObject({
      path: [key, 0],
      code: "too_big",
    });
  }
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

test("uses the higher PDF reservation and retains it for unknown usage", async () => {
  const document = {
    ...items[0],
    name: "sample.pdf",
    format: "pdf" as const,
    coverage: { kind: "original" as const, sourceBytes: 784, dimensions: null },
  };
  const infer = vi.fn<FileAnalysisPort["infer"]>().mockResolvedValue({
    dispatch: "dispatched",
    error: { code: "requestRejected" },
  });
  const analysis = createFileAnalysis({
    prepare: vi.fn(),
    approve: vi.fn(),
    discard: vi.fn(),
    infer,
  });
  await analysis.run(
    "plan",
    [document],
    5_999_999,
    new AbortController().signal,
    vi.fn(),
  );
  expect(infer).not.toHaveBeenCalled();
  await analysis.run(
    "plan",
    [document],
    10_000_000,
    new AbortController().signal,
    vi.fn(),
  );
  expect(infer).toHaveBeenCalledTimes(1);
  expect(analysis.usage()).toMatchObject({
    reserved: 6_000_000,
    inFlight: 0,
    unresolved: 1,
  });
});
