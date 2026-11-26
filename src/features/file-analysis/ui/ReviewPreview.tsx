import { fileVisualKind } from "../../../components/motion/Artwork";
import {
  FilesystemBrowser,
  rowPageSize,
  FileTypeIcon,
} from "./FilesystemBrowser";
import { useLayoutEffect, useRef, useState } from "react";
import type { Discovery, FileId } from "../../discovery/application/contracts";
import { suggestedName } from "../application/contracts";
import type { Entry } from "../application/contracts";
import {
  projectPreview,
  selectableFiles,
  selectionState,
  toggleSelection,
} from "../application/preview";
import type { Draft, Drafts, ReviewNode } from "../application/preview";
import type { FileProgress } from "../application/workflow";

function IncludeCheckbox({
  name,
  ids,
  excluded,
  onToggle,
}: {
  name: string;
  ids: FileId[];
  excluded: ReadonlySet<FileId>;
  onToggle: () => void;
}) {
  const { checked, mixed } = selectionState(ids, excluded);
  if (!ids.length) return null;
  return (
    <input
      type="checkbox"
      aria-label={`Include ${name} in proposal`}
      checked={checked}
      ref={(input) => {
        if (input) input.indeterminate = mixed;
      }}
      onChange={onToggle}
    />
  );
}

export function ReviewPreview({
  files,
  progress,
  onBack,
  folder,
  entries,
  busy,
  onPreview,
  preview,
  onPreviewError,
  onPreviewLoad,
}: {
  files: Discovery["files"];
  progress: Partial<Record<FileId, FileProgress>>;
  onBack: () => void;
  folder: string;
  entries: Entry[];
  busy: boolean;
  onPreview: (id: FileId, name: string) => void;
  preview?: { url: string; fileId: FileId };
  onPreviewError: () => void;
  onPreviewLoad: () => void;
}) {
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const [excluded, setExcluded] = useState<ReadonlySet<FileId>>(
    () => new Set(),
  );
  const [edits, setEdits] = useState<Drafts>({});
  const [inspected, setInspected] = useState<FileId>();
  const [form, setForm] = useState<Draft>();
  const [message, setMessage] = useState("");
  const tree = useRef<HTMLDivElement>(null);
  const pendingFocus = useRef<{ id?: FileId; category?: string } | undefined>(
    undefined,
  );
  const { unchanged, categories, drafts, destinations, issues } =
    projectPreview(files, progress, edits, excluded);
  const file = files.find((item) => item.fileId === inspected);
  const entry = entries.find((item) => item.fileId === inspected);
  const outcome = inspected ? progress[inspected] : undefined;
  const result =
    outcome?.state === "finished" && "result" in outcome.attempt
      ? outcome.attempt.result
      : undefined;
  const draft = inspected ? drafts.get(inspected) : undefined;

  useLayoutEffect(() => {
    const next = pendingFocus.current;
    if (!next) return;
    pendingFocus.current = undefined;
    const inputs = [
      ...(tree.current?.querySelectorAll<HTMLInputElement>("input") ?? []),
    ];
    const target = inputs.find((input) =>
      next.id
        ? input.closest("li")?.dataset.file === next.id
        : input.closest("li")?.dataset.category === next.category,
    );
    (target ?? inputs[0])?.focus();
  }, [excluded]);

  function showFile(id: FileId) {
    setInspected(id);
    setForm(undefined);
    setMessage("");
  }

  function saveDraft(id: FileId, value: Draft) {
    const next = { ...edits, [id]: value };
    const included = new Set(excluded);
    included.delete(id);
    const check = projectPreview(files, progress, next, included);
    const issue = check.issues.get(id);
    if (issue) {
      setMessage(issue);
      return;
    }
    setEdits(next);
    setForm(undefined);
    setMessage("");
  }

  function fileStatus(id: FileId) {
    const state = progress[id];
    if (issues.has(id)) return "Conflict";
    if (excluded.has(id)) return "Not included";
    if (state?.state === "finished") {
      if ("error" in state.attempt)
        return state.attempt.error.code === "cancelled"
          ? "Cancelled"
          : "Analysis failed";
      return drafts.has(id) ? "" : "Unresolved";
    }
    if (
      entries.some((item) => item.fileId === id && item.status === "excluded")
    )
      return "Excluded from analysis";
    return state?.state === "skipped"
      ? "Skipped"
      : state?.state === "cancelled"
        ? "Cancelled"
        : "";
  }

  const leaf = (file: Discovery["files"][number]): ReviewNode => ({
    kind: "file",
    file,
  });
  const root: ReviewNode = {
    kind: "folder",
    name: folder,
    children: [
      ...[...categories].map(([name, children]): ReviewNode => ({
        kind: "folder",
        name,
        children: children.map(leaf),
      })),
      ...unchanged.map(leaf),
    ],
  };
  const moved = [...categories.values()].flat();
  const originals = new Map(
    files.map((file) => [file.fileId, file.displayName]),
  );
  const proposed = [...moved, ...unchanged];
  const matching = proposed.filter((file) =>
    [
      file.displayName,
      originals.get(file.fileId),
      drafts.get(file.fileId)?.destination,
    ].some((value) =>
      value?.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
    ),
  );
  const pageIds = new Set(
    matching
      .slice(page * rowPageSize, (page + 1) * rowPageSize)
      .map((file) => file.fileId),
  );
  const renamed = proposed.filter(
    (file) => file.displayName !== originals.get(file.fileId),
  );
  const changed = new Set([...moved, ...renamed].map((file) => file.fileId));
  const includesPage = (node: ReviewNode): boolean =>
    node.kind === "file"
      ? pageIds.has(node.file.fileId)
      : node.children.some(includesPage);

  function renderNode(node: ReviewNode, isRoot = false) {
    const ids = selectableFiles(node, drafts);
    if (node.kind === "folder") {
      const members = isRoot
        ? ids
        : [...drafts]
            .filter(([, draft]) => draft.destination === node.name)
            .map(([id]) => id);
      return (
        <li key={node.name} data-category={isRoot ? undefined : node.name}>
          <div className="tree-folder">
            <IncludeCheckbox
              name={node.name}
              ids={members}
              excluded={excluded}
              onToggle={() => {
                if (!isRoot) pendingFocus.current = { category: node.name };
                setExcluded(toggleSelection(members, excluded));
              }}
            />
            <details open>
              <summary>
                <span className="folder-icon" aria-hidden="true" />
                {node.name}{" "}
                <small>
                  {node.children.length}{" "}
                  {isRoot ? "items" : "files · Proposed folder"}
                </small>
              </summary>
              <ul>
                {node.children
                  .filter(includesPage)
                  .map((child) => renderNode(child))}
              </ul>
            </details>
          </div>
        </li>
      );
    }
    const id = node.file.fileId;
    const status = fileStatus(id);
    return (
      <li key={id} data-file={id} className="tree-file">
        <IncludeCheckbox
          name={node.file.displayName}
          ids={ids}
          excluded={excluded}
          onToggle={() => {
            pendingFocus.current = { id };
            setExcluded(toggleSelection(ids, excluded));
          }}
        />
        <button
          type="button"
          aria-pressed={id === inspected}
          onClick={() => showFile(id)}
        >
          <FileTypeIcon tone={fileVisualKind(node.file.extension)} />
          {node.file.displayName}
        </button>
        {status && (
          <small
            data-status={
              status === "Conflict" || status === "Analysis failed"
                ? "error"
                : undefined
            }
          >
            {status}
          </small>
        )}
      </li>
    );
  }

  return (
    <section aria-label="Review changes" className="review-preview">
      <div className="stage-count">
        <strong>{changed.size.toLocaleString()}</strong> files with proposed
        changes
      </div>
      <p className="outcome-row">
        <span>
          {moved.length} {moved.length === 1 ? "move" : "moves"}
        </span>
        <span>
          {renamed.length} {renamed.length === 1 ? "rename" : "renames"}
        </span>
        <span>{files.length - changed.size} unchanged</span>
        {issues.size > 0 && <span>{issues.size} conflicts</span>}
      </p>
      <div className="review-layout">
        <FilesystemBrowser
          title="Proposed structure"
          query={query}
          onSearch={(value) => {
            setQuery(value);
            setPage(0);
          }}
          scrollRef={tree}
          footer={
            <>
              <span>{matching.length} files</span>
              {matching.length > rowPageSize && (
                <div>
                  <button disabled={!page} onClick={() => setPage(page - 1)}>
                    Previous
                  </button>{" "}
                  <button
                    disabled={(page + 1) * rowPageSize >= matching.length}
                    onClick={() => setPage(page + 1)}
                  >
                    Next
                  </button>
                </div>
              )}
            </>
          }
        >
          <ul className="file-tree">{renderNode(root, true)}</ul>
        </FilesystemBrowser>
        {file && (
          <aside className="review-inspector" aria-label="File details">
            <dl>
              <dt>Original name</dt>
              <dd>{file.displayName}</dd>
              <dt>Original location</dt>
              <dd>{folder}</dd>
              {draft && (
                <>
                  <dt>Proposed name</dt>
                  <dd>{draft.name}</dd>
                  <dt>Destination</dt>
                  <dd>
                    {draft.destination
                      ? `${folder} / ${draft.destination}`
                      : folder}
                  </dd>
                </>
              )}
            </dl>
            {draft && (
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  saveDraft(file.fileId, form ?? draft);
                }}
              >
                <label>
                  Filename
                  <input
                    value={(form ?? draft).name}
                    onChange={(event) =>
                      setForm({ ...(form ?? draft), name: event.target.value })
                    }
                  />
                </label>
                <label>
                  Destination
                  <select
                    value={(form ?? draft).destination}
                    onChange={(event) =>
                      setForm({
                        ...(form ?? draft),
                        destination: event.target.value,
                      })
                    }
                  >
                    <option value="">{folder} (original folder)</option>
                    {destinations.map((destination) => (
                      <option key={destination}>{destination}</option>
                    ))}
                  </select>
                </label>
                <button type="submit">Update draft</button>
              </form>
            )}
            {(message || issues.get(file.fileId)) && (
              <p role="status" data-status="error">
                {message || issues.get(file.fileId)}
              </p>
            )}
            {fileStatus(file.fileId) && (
              <p>{fileStatus(file.fileId)} · Original location retained</p>
            )}
            {result && (
              <details open>
                <summary>Classification</summary>
                <p>{result.summary}</p>
                {result.likelyPurpose && <p>{result.likelyPurpose}</p>}
                {result.observations.length > 0 && (
                  <ul>
                    {result.observations.map((item, index) => (
                      <li key={index}>{item}</li>
                    ))}
                  </ul>
                )}
                {result.uncertainty.map((item, index) => (
                  <p key={index}>{item}</p>
                ))}
                {entry?.status === "ready" && result.suggestedStem && (
                  <p>
                    Suggested filename ·{" "}
                    {suggestedName(result.suggestedStem, entry) ??
                      "Unavailable"}
                  </p>
                )}
              </details>
            )}
            {/^(png|jpe?g)$/i.test(file.extension ?? "") && (
              <button
                type="button"
                disabled={busy}
                onClick={() => onPreview(file.fileId, file.displayName)}
              >
                Preview image
              </button>
            )}
            {preview?.fileId === file.fileId && (
              <img
                src={preview.url}
                alt={`Thumbnail of ${file.displayName}`}
                onError={onPreviewError}
                onLoad={onPreviewLoad}
              />
            )}
          </aside>
        )}
      </div>
      <div className="workflow-dock">
        <strong>
          {changed.size} {changed.size === 1 ? "change" : "changes"} selected
        </strong>
        <span>
          {issues.size ? `${issues.size} conflicts · ` : ""}Read-only proposal
        </span>
        <button onClick={onBack}>Back to Analyze</button>
      </div>
    </section>
  );
}
