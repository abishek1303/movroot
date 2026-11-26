import type { Discovery, FileId } from "../../discovery/application/contracts";
import type { SemanticFileAnalysis } from "./contracts";
import type { FileProgress } from "./workflow";

const categoryByPresentation: Partial<
  Record<SemanticFileAnalysis["presentation"], string>
> = {
  screenshot: "Screenshots",
  photo: "Photos",
  illustration: "Illustrations",
  document: "Documents",
  table: "Tables",
  data: "Data",
};

type File = Discovery["files"][number];
type Results = Partial<Record<FileId, FileProgress>>;
export type Draft = { name: string; destination: string };
export type Drafts = Partial<Record<FileId, Draft>>;
type Category = (result: SemanticFileAnalysis) => string | undefined;

export function categoryForResult(result: SemanticFileAnalysis) {
  return result.uncertainty.length
    ? undefined
    : categoryByPresentation[result.presentation];
}

export function suggestedDrafts(
  files: File[],
  progress: Results,
  categorize: Category = (result) =>
    categoryByPresentation[result.presentation],
) {
  const drafts = new Map<FileId, Draft>();
  for (const file of files) {
    const outcome = progress[file.fileId];
    if (outcome?.state !== "finished" || !("result" in outcome.attempt))
      continue;
    const result = outcome.attempt.result;
    const destination = result.uncertainty.length
      ? undefined
      : categorize(result);
    if (destination)
      drafts.set(file.fileId, { name: file.displayName, destination });
  }
  return drafts;
}

function comparisonKey(name: string) {
  return name.normalize("NFC").toLowerCase();
}

function validComponent(name: string) {
  return (
    name.length > 0 &&
    new TextEncoder().encode(name).length <= 255 &&
    name.trim() === name &&
    !/[. ]$/.test(name) &&
    !/[<>:"/\\|?*\p{Cc}\u202a-\u202e\u2066-\u2069]/u.test(name) &&
    !/^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(name)
  );
}

export function projectPreview(
  files: File[],
  progress: Results,
  edits: Drafts = {},
  excluded: ReadonlySet<FileId> = new Set(),
  categorize?: Category,
) {
  const defaults = suggestedDrafts(files, progress, categorize);
  const destinations = [
    ...new Set([...defaults.values()].map((draft) => draft.destination)),
  ].sort();
  const drafts = new Map<FileId, Draft>();
  const issues = new Map<FileId, string>();
  const occupied = new Map<string, number>();
  for (const file of files) {
    const key = comparisonKey(file.displayName);
    occupied.set(key, (occupied.get(key) ?? 0) + 1);
  }

  const targets = new Map<string, FileId[]>();
  for (const file of files) {
    const initial = defaults.get(file.fileId);
    if (!initial) continue;
    const draft = edits[file.fileId] ?? initial;
    drafts.set(file.fileId, draft);
    if (excluded.has(file.fileId)) continue;
    const name = comparisonKey(draft.name);
    const folder = comparisonKey(draft.destination);
    if (!validComponent(draft.name)) {
      issues.set(file.fileId, "Enter a valid filename.");
    } else if (
      folder &&
      (!destinations.includes(draft.destination) ||
        !validComponent(draft.destination))
    ) {
      issues.set(file.fileId, "Choose an available destination.");
    } else if (
      folder
        ? occupied.has(folder)
        : (occupied.get(name) ?? 0) >
            Number(name === comparisonKey(file.displayName)) ||
          destinations.some(
            (destination) => comparisonKey(destination) === name,
          )
    ) {
      issues.set(
        file.fileId,
        "The destination conflicts with a discovered name.",
      );
    } else if (occupied.get(comparisonKey(file.displayName)) !== 1) {
      issues.set(file.fileId, "The source name is ambiguous in this listing.");
    } else {
      const key = JSON.stringify([folder, name]);
      const matching = targets.get(key) ?? [];
      matching.push(file.fileId);
      targets.set(key, matching);
    }
  }
  for (const matching of targets.values()) {
    if (matching.length > 1) {
      for (const id of matching)
        issues.set(id, "Another draft uses this destination and name.");
    }
  }

  const unchanged: File[] = [];
  const categories = new Map<string, File[]>();
  for (const file of files) {
    const draft = drafts.get(file.fileId);
    if (!draft || excluded.has(file.fileId) || issues.has(file.fileId)) {
      unchanged.push(file);
      continue;
    }
    const projected = { ...file, displayName: draft.name };
    if (!draft.destination) {
      unchanged.push(projected);
      continue;
    }
    const children = categories.get(draft.destination) ?? [];
    children.push(projected);
    categories.set(draft.destination, children);
  }
  return { unchanged, categories, drafts, destinations, issues };
}

export type ReviewNode =
  | { kind: "file"; file: File }
  | { kind: "folder"; name: string; children: ReviewNode[] };

export function selectableFiles(
  node: ReviewNode,
  drafts: ReadonlyMap<FileId, Draft>,
): FileId[] {
  if (node.kind === "folder")
    return node.children.flatMap((child) => selectableFiles(child, drafts));
  return drafts.has(node.file.fileId) ? [node.file.fileId] : [];
}

export function selectionState(ids: FileId[], excluded: ReadonlySet<FileId>) {
  const selected = ids.filter((id) => !excluded.has(id)).length;
  return {
    checked: ids.length > 0 && selected === ids.length,
    mixed: selected > 0 && selected < ids.length,
  };
}

export function toggleSelection(ids: FileId[], excluded: ReadonlySet<FileId>) {
  const next = new Set(excluded);
  const { checked } = selectionState(ids, excluded);
  for (const id of ids) {
    if (checked) next.add(id);
    else next.delete(id);
  }
  return next;
}
