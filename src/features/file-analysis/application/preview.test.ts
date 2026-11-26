import { expect, test } from "vitest";
import { fileIdSchema } from "../../discovery/application/contracts";
import { semanticAnalysis } from "./contracts";
import {
  projectPreview,
  selectableFiles,
  selectionState,
  toggleSelection,
} from "./preview";

const sample = semanticAnalysis.parse({
  presentation: "photo",
  semanticType: "photo",
  summary: "A photo",
  observations: [],
  topic: null,
  likelyPurpose: null,
  tags: [],
  entities: [],
  suggestedStem: null,
  sensitivity: [],
  uncertainty: [],
});

test("projects validated results and keeps uncertain, failed, and untouched files at their source", () => {
  const files = ["photo", "uncertain", "failed", "untouched"].map(
    (displayName) => ({
      fileId: fileIdSchema.parse(displayName),
      displayName,
    }),
  );
  const [photo, uncertain, failed] = files;
  const preview = projectPreview(files, {
    [photo.fileId]: {
      state: "finished",
      attempt: { dispatch: "dispatched", result: sample },
    },
    [uncertain.fileId]: {
      state: "finished",
      attempt: {
        dispatch: "dispatched",
        result: { ...sample, uncertainty: ["Unclear subject"] },
      },
    },
    [failed.fileId]: {
      state: "finished",
      attempt: { dispatch: "dispatched", error: { code: "invalidResponse" } },
    },
  });
  expect(preview.categories.get("Photos")).toEqual([photo]);
  expect(preview.unchanged).toEqual(files.slice(1));
});

test("keeps proposed files at their source when the category collides with a listed file", () => {
  const files = ["image", "PHOTOS"].map((displayName) => ({
    fileId: fileIdSchema.parse(displayName),
    displayName,
  }));
  const preview = projectPreview(files, {
    [files[0].fileId]: {
      state: "finished",
      attempt: { dispatch: "dispatched", result: sample },
    },
  });
  expect(preview.categories.size).toBe(0);
  expect(preview.unchanged).toEqual(files);
});

test("validates renamed destinations, preserves exclusions, and accepts a replaceable category source", () => {
  const files = ["a.jpg", "b.jpg", "occupied.jpg"].map((displayName) => ({
    fileId: fileIdSchema.parse(displayName),
    displayName,
  }));
  const [a, b] = files;
  const progress = {
    [a.fileId]: {
      state: "finished",
      attempt: { dispatch: "dispatched", result: sample },
    },
    [b.fileId]: {
      state: "finished",
      attempt: {
        dispatch: "dispatched",
        result: { ...sample, presentation: "document" },
      },
    },
  } as const;
  const edit = { [a.fileId]: { destination: "Letters", name: "portrait.jpg" } };
  const categorize = (result: typeof sample) =>
    result.presentation === "photo" ? "Images" : "Letters";
  expect(
    projectPreview(files, progress, edit, new Set(), categorize).categories.get(
      "Letters",
    ),
  ).toEqual([{ ...a, displayName: "portrait.jpg" }, b]);
  expect(
    projectPreview(files, progress, edit, new Set([a.fileId]), categorize)
      .unchanged,
  ).toContain(a);
  for (const name of ["../outside", "NUL.txt", "name.", "bad\\name", "b.JPG"]) {
    const result = projectPreview(
      files,
      progress,
      { [a.fileId]: { destination: "Letters", name } },
      new Set(),
      categorize,
    );
    expect(result.issues.has(a.fileId)).toBe(true);
    expect(result.unchanged).toContain(a);
  }
  expect(
    projectPreview(files, progress, {
      [a.fileId]: { destination: "", name: "OCCUPIED.jpg" },
    }).issues.has(a.fileId),
  ).toBe(true);
  expect(
    projectPreview(files, progress, {
      [a.fileId]: { destination: "Unlisted", name: "a.jpg" },
    }).issues.has(a.fileId),
  ).toBe(true);
});

test("recursive selection includes collapsed descendants and excludes unsupported leaves", () => {
  const [a, b, unresolved] = ["a", "b", "unresolved"].map((name) => ({
    fileId: fileIdSchema.parse(name),
    displayName: name,
  }));
  const candidates = new Map(
    [a, b].map((file) => [
      file.fileId,
      { name: file.displayName, destination: "Photos" },
    ]),
  );
  const ids = selectableFiles(
    {
      kind: "folder",
      name: "Root",
      children: [
        { kind: "file", file: a },
        {
          kind: "folder",
          name: "Nested",
          children: [
            { kind: "file", file: b },
            { kind: "file", file: unresolved },
          ],
        },
      ],
    },
    candidates,
  );
  const mixed = toggleSelection([b.fileId], new Set());
  expect(ids).toEqual([a.fileId, b.fileId]);
  expect(selectionState(ids, mixed)).toEqual({ checked: false, mixed: true });
  const all = toggleSelection(ids, mixed);
  expect(selectionState(ids, all).checked).toBe(true);
  expect(toggleSelection(ids, all)).toEqual(new Set(ids));
});
