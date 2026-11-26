import { expect, test } from "vitest";
import { semanticAnalysis } from "../application/contracts";
import { analysisMotionSignal } from "./analysisMotionSignal";

const sample = semanticAnalysis.parse({
  presentation: "document",
  semanticType: "letter",
  summary: "A letter",
  observations: [],
  topic: null,
  likelyPurpose: null,
  tags: [],
  entities: [],
  suggestedStem: null,
  sensitivity: [],
  uncertainty: [],
});

test("routes validated classifications and keeps unresolved results out of destination folders", () => {
  expect(
    analysisMotionSignal({
      state: "finished",
      attempt: { result: sample, dispatch: "dispatched" },
    }),
  ).toEqual({ kind: "classified", category: "Documents" });
  expect(
    analysisMotionSignal({
      state: "finished",
      attempt: {
        result: { ...sample, uncertainty: ["Unclear"] },
        dispatch: "dispatched",
      },
    }),
  ).toEqual({ kind: "uncertain" });
  expect(
    analysisMotionSignal({
      state: "finished",
      attempt: { error: { code: "invalidResponse" }, dispatch: "dispatched" },
    }),
  ).toEqual({ kind: "failed" });
  expect(
    analysisMotionSignal({
      state: "finished",
      attempt: { error: { code: "cancelled" }, dispatch: "dispatched" },
    }),
  ).toEqual({ kind: "cancelled" });
  expect(analysisMotionSignal({ state: "skipped" })).toEqual({
    kind: "skipped",
  });
});
