import { DiscoverPopover } from "../../discovery/ui/DiscoverPopover";
import {
  DistributionBreakdown,
  FilesystemBrowser,
  fileSize,
  FileTypeIcon,
  rowPageSize,
} from "./FilesystemBrowser";
import { fileVisualKind } from "../../../components/motion/Artwork";
import type { CredentialSettings } from "../../inference/application/provider";
import type { Failure } from "../../inference/application/contracts";
import { Flip, gsap, useGSAP } from "../../../components/motion/engine";
import { analysisMotionSignal } from "./analysisMotionSignal";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type {
  Discovery,
  FileId,
  ScopeId,
} from "../../discovery/application/contracts";
import { formatMismatch, suggestedName } from "../application/contracts";
import type { Entry, ImageMode, Ready } from "../application/contracts";
import { ReviewPreview } from "./ReviewPreview";
import { fileAnalysisPolicy } from "../application/workflow";
import type { FileAnalysis, FileProgress } from "../application/workflow";

const money = (nanodollars: number) =>
  `$${(nanodollars / 1_000_000_000).toFixed(9)}`;
const displayMoney = (nanodollars: number) => {
  const dollars = nanodollars / 1_000_000_000;
  if (dollars > 0 && dollars < 0.001) return "< $0.001";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 3,
  }).format(dollars);
};
const eligible = (entry: Entry): entry is Ready => entry.status === "ready";

function description(entry: Entry) {
  if (entry.status === "excluded") {
    return (
      (
        {
          pdfEncrypted: "Encrypted PDFs are unsupported.",
          unsupportedResource: "Unsupported file format or structure.",
          limitExceeded: "File exceeds preparation limits.",
          decodeFailed: "Malformed content or unsupported encoding.",
          resourceChanged: "File changed. Refresh the listing and check again.",
        } as Record<string, string>
      )[entry.error] ?? `Excluded (${entry.error}).`
    );
  }
  const coverage = entry.coverage;
  if (coverage.kind === "original") {
    const detail = coverage.dimensions
      ? coverage.dimensions.join(" × ")
      : "PDF page coverage is uncertain";
    return `Original ${entry.format.toUpperCase()} · all ${coverage.sourceBytes} source bytes · ${detail} · embedded metadata and hidden content included${formatMismatch(entry) ? " · extension differs from detected format" : ""}`;
  }
  const detail =
    coverage.kind === "text"
      ? `${coverage.sourceBytes === coverage.coveredBytes ? "Full text" : "Text excerpt"} · ${coverage.coveredBytes} of ${coverage.sourceBytes} source bytes · ${coverage.transmittedBytes} normalized bytes${coverage.bomRemoved ? " · BOM removed" : ""}${coverage.lineEndingsNormalized ? " · line endings normalized" : ""}`
      : `Full frame · ${coverage.original.join(" × ")} → ${coverage.transmitted.join(" × ")} · re-encoded${coverage.resized ? " and resized" : ""}${coverage.orientationApplied ? " · orientation applied" : ""} · ${coverage.sourceBytes} source bytes → ${coverage.transmittedBytes} prepared bytes`;
  return `${entry.format.toUpperCase()} · ${detail}${formatMismatch(entry) ? " · extension differs from detected format" : ""}`;
}

function ModelText({
  text,
  preview = text,
  limit = 240,
}: {
  text: string;
  preview?: string;
  limit?: number;
}) {
  const characters = Array.from(preview);
  const shortened = characters.length > limit;
  if (!shortened && preview === text) return text;
  const excerpt = shortened
    ? `${characters
        .slice(0, limit - 1)
        .join("")
        .trimEnd()}…`
    : preview;
  return (
    <details>
      <summary>{excerpt} (show full)</summary>
      <p>{text}</p>
    </details>
  );
}

function ModelList({
  values,
  count,
  separator,
}: {
  values: string[];
  count: number;
  separator: string;
}) {
  return (
    <ModelText
      text={values.join(separator)}
      preview={values.slice(0, count).join(separator)}
    />
  );
}

function failureMessage(code: Failure["code"]) {
  switch (code) {
    case "credentialMissing":
      return "Add a Meta API key to analyze these files.";
    case "authentication":
    case "invalidCredential":
      return "Meta could not accept this API key. Check it in Settings.";
    case "credentialStore":
    case "credentialConfiguration":
      return "The API key could not be read. Check your provider settings.";
    case "accessDenied":
      return "This project does not have access to the analysis model.";
    case "rateLimited":
      return "Meta is limiting requests. Try again shortly.";
    case "timeout":
      return "Meta did not respond in time.";
    case "budgetExceeded":
      return "The provider request limit has been reached.";
    case "staleSession":
    case "busy":
      return "Analysis is temporarily unavailable. Try again.";
    case "cancelled":
      return "Analysis was cancelled.";
    default:
      return "A file could not be analyzed. See file details.";
  }
}

function needsKey(code?: Failure["code"]) {
  return (
    code === "credentialMissing" ||
    code === "authentication" ||
    code === "invalidCredential" ||
    code === "credentialConfiguration" ||
    code === "credentialStore"
  );
}

export function FileAnalysisPanel({
  analysis,
  credentials,
  onConfigure,
  scope,
  files,
  deviceBusy,
  review,
  onReview,
  onBusy,
  resetSignal,
  motionEnabled,
  onAnalysisStarted,
  discovering,
  onDiscover,
  folder,
  onPreview,
  preview,
  onPreviewError,
  onPreviewLoad,
}: {
  analysis: FileAnalysis;
  credentials: CredentialSettings;
  onConfigure: () => void;
  scope: ScopeId;
  files: Discovery["files"];
  deviceBusy: boolean;
  review: boolean;
  onReview: (review: boolean) => void;
  onBusy: (busy: boolean) => void;
  resetSignal: AbortSignal;
  motionEnabled: boolean;
  onAnalysisStarted: () => void;
  discovering: boolean;
  onDiscover: () => void;
  folder: string;
  onPreview: (id: FileId, name: string) => void;
  preview?: { url: string; fileId: FileId };
  onPreviewError: () => void;
  onPreviewLoad: () => void;
}) {
  const [selection, setSelection] = useState<FileId[]>(() =>
    files.length <= fileAnalysisPolicy.selection
      ? files.map(({ fileId }) => fileId)
      : [],
  );
  const discoverStage = useRef<HTMLDivElement>(null);
  const changedSelection = useRef<FileId | undefined>(undefined);
  useGSAP(
    () => {
      const id = changedSelection.current;
      changedSelection.current = undefined;
      if (!id || !discovering || !motionEnabled) return;
      const box = Array.from(
        discoverStage.current?.querySelectorAll<HTMLInputElement>(
          "[data-selection-id]",
        ) ?? [],
      ).find((input) => input.dataset.selectionId === id);
      if (box)
        gsap.from(box, { scale: 0.84, duration: 0.17, ease: "power2.out" });
    },
    {
      scope: discoverStage,
      dependencies: [selection, discovering, motionEnabled],
      revertOnUpdate: true,
    },
  );
  const [entries, setEntries] = useState<Entry[]>([]);
  const [progress, setProgress] = useState<
    Partial<Record<FileId, FileProgress>>
  >({});
  const [stage, setStage] = useState<"checking" | "reviewing" | "running">();
  const [failure, setFailure] = useState<Failure["code"]>();
  const [cancelledRun, setCancelledRun] = useState(false);
  const [message, setMessage] = useState("");
  const [imageMode, setImageMode] = useState<ImageMode>("prepared");
  const [budget, setBudget] = useState(fileAnalysisPolicy.defaultBudget);
  const operation = useRef<AbortController | undefined>(undefined);
  const plan = useRef<string | undefined>(undefined);
  const [cancelling, setCancelling] = useState(false);
  const analysisVisual = useRef<HTMLDivElement>(null);
  const flipState = useRef<ReturnType<typeof Flip.getState> | undefined>(
    undefined,
  );
  const [openedReview, setOpenedReview] = useState(false);
  const reviewContent = useRef<HTMLDivElement>(null);
  const reviewButton = useRef<HTMLButtonElement>(null);
  const lastReview = useRef(false);
  useLayoutEffect(() => {
    if (lastReview.current === review) return;
    lastReview.current = review;
    (review ? reviewContent.current : reviewButton.current)?.focus();
  }, [review]);
  useGSAP(
    () => {
      const state = flipState.current;
      flipState.current = undefined;
      if (!review || !motionEnabled || !state || !reviewContent.current) return;
      const transition = Flip.from(state, {
        targets: reviewContent.current,
        scale: true,
        duration: 0.32,
        ease: "power2.out",
        prune: true,
      });
      return () => transition.revert();
    },
    { dependencies: [review, motionEnabled], revertOnUpdate: true },
  );
  const [batch, setBatch] = useState<FileId[]>([]);

  useEffect(
    () => () => {
      operation.current?.abort();
      if (plan.current) void analysis.port.discard(plan.current);
    },
    [analysis],
  );

  async function startAnalysis(ids = selection) {
    if (operation.current || resetSignal.aborted || !ids.length) return;
    const controller = new AbortController();
    const { signal } = controller;
    let id: string | undefined;
    const abort = () => {
      controller.abort();
      if (id) void analysis.port.discard(id);
    };
    operation.current = controller;
    resetSignal.addEventListener("abort", abort, { once: true });
    onBusy(true);
    setCancelling(false);
    setStage("checking");
    setMessage("");
    setFailure(undefined);
    setCancelledRun(false);
    try {
      const credential = await credentials.status();
      if (signal.aborted) {
        setMessage("Preparation cancelled.");
        return;
      }
      if (!credential.ok || credential.value.source === "missing") {
        const code = credential.ok
          ? "credentialMissing"
          : credential.error.code;
        setFailure(code);
        setMessage(failureMessage(code));
        return;
      }
      const result = await analysis.port.prepare(scope, ids, signal, imageMode);
      if ("manifest" in result) {
        id = result.manifest.planId;
        plan.current = id;
      }
      if (signal.aborted) {
        setMessage("Preparation cancelled.");
        return;
      }
      if ("error" in result) {
        setMessage(
          result.error === "resourceChanged" || result.error === "unknownFile"
            ? "The folder contents changed. Start over to read the files again."
            : "Could not prepare the selected files. Try again.",
        );
        return;
      }
      const prepared = result.manifest;
      setEntries((previous) => [
        ...previous.filter(
          (entry) =>
            !prepared.items.some((item) => item.fileId === entry.fileId),
        ),
        ...prepared.items,
      ]);
      const items = prepared.items.filter(eligible);
      if (!items.length) {
        setMessage("None of the selected files can be sent. See file details.");
        return;
      }

      setStage("reviewing");
      const approved = await analysis.port.approve(prepared.planId);
      if (!approved || signal.aborted) {
        setMessage("Transmission cancelled.");
        return;
      }
      setFilter(undefined);
      setPage(0);
      onAnalysisStarted();
      setBatch(items.map(({ fileId }) => fileId));
      setProgress((previous) => ({
        ...previous,
        ...Object.fromEntries(
          items.map(({ fileId }) => [fileId, { state: "queued" }]),
        ),
      }));
      setStage("running");
      let failedCode: Failure["code"] | undefined;
      const status = await analysis.run(
        prepared.planId,
        items,
        budget,
        signal,
        (file, value) => {
          setProgress((previous) => ({ ...previous, [file]: value }));
          if (
            value.state === "finished" &&
            "error" in value.attempt &&
            value.attempt.error.code !== "cancelled"
          ) {
            const code = value.attempt.error.code;
            if (!failedCode || needsKey(code)) failedCode = code;
          }
        },
      );
      setFailure(failedCode);
      setCancelledRun(signal.aborted);
      setMessage(
        signal.aborted
          ? "Remaining work cancelled. Meta may still process a dispatched request."
          : failedCode
            ? failureMessage(failedCode)
            : status,
      );
    } catch {
      setMessage(
        signal.aborted
          ? "Analysis cancelled."
          : "Analysis was interrupted. Try again.",
      );
    } finally {
      try {
        if (id) await analysis.port.discard(id);
      } finally {
        resetSignal.removeEventListener("abort", abort);
        plan.current = undefined;
        operation.current = undefined;
        setStage(undefined);
        onBusy(false);
      }
    }
  }

  function toggle(file: FileId) {
    changedSelection.current = file;
    setSelection((previous) =>
      previous.includes(file)
        ? previous.filter((id) => id !== file)
        : [...previous, file],
    );
  }

  const usage = analysis.usage();
  const outcomes = batch.map((id) => progress[id]);
  const success = outcomes.filter(
    (item) => item?.state === "finished" && "result" in item.attempt,
  ).length;
  const failed = outcomes.filter(
    (item) =>
      item?.state === "finished" &&
      "error" in item.attempt &&
      item.attempt.error.code !== "cancelled",
  ).length;
  const cancelled = outcomes.filter(
    (item) =>
      item?.state === "cancelled" ||
      (item?.state === "finished" &&
        "error" in item.attempt &&
        item.attempt.error.code === "cancelled"),
  ).length;
  const skipped = outcomes.filter((item) => item?.state === "skipped").length;
  const uncertain = outcomes.filter(
    (item) => item && analysisMotionSignal(item)?.kind === "uncertain",
  ).length;
  const hasResults = Object.values(progress).some(
    (item) => item?.state === "finished" && "result" in item.attempt,
  );
  const canReview = hasResults && !stage && !deviceBusy;
  const running = stage === "running";
  const settled = success + failed + skipped + cancelled;
  const processing = outcomes.filter(
    (item) => item?.state === "analyzing",
  ).length;
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<string>();
  const [sort, setSort] = useState("listing");
  const [page, setPage] = useState(0);
  const [inspected, setInspected] = useState<FileId>();
  const activeBatch = new Set(batch);
  const categories = new Map<FileId, string>();
  const typeOf = (extension?: string) => {
    const suffix = extension?.toLowerCase() ?? "";
    if (/^(mp4|mov|mkv|webm|avi)$/.test(suffix))
      return { name: "Videos", tone: "video" };
    if (/^(mp3|wav|m4a|flac|ogg)$/.test(suffix))
      return { name: "Audio", tone: "audio" };
    if (/^(zip|7z|rar|tar|gz)$/.test(suffix))
      return { name: "Archives", tone: "archive" };
    const tone = fileVisualKind(extension);
    return {
      tone,
      name: {
        image: "Images",
        pdf: "PDFs",
        text: "Documents",
        data: "Spreadsheets & data",
        other: "Other",
      }[tone],
    };
  };
  for (const id of batch) {
    const value = progress[id];
    if (!value) continue;
    const signal = analysisMotionSignal(value);
    if (signal?.kind === "classified") categories.set(id, signal.category);
    if (signal?.kind === "uncertain") categories.set(id, "Needs review");
  }
  const groups = new Map<
    string,
    { name: string; count: number; tone?: string }
  >();
  const stageFiles = discovering
    ? files
    : files.filter(({ fileId }) => activeBatch.has(fileId));
  for (const file of stageFiles) {
    const kind = typeOf(file.extension);
    const name = discovering ? kind.name : categories.get(file.fileId);
    if (name)
      groups.set(name, {
        name,
        count: (groups.get(name)?.count ?? 0) + 1,
        tone: discovering ? kind.tone : undefined,
      });
  }
  const visibleFiles = stageFiles.filter(
    (file) =>
      file.displayName
        .toLocaleLowerCase()
        .includes(query.trim().toLocaleLowerCase()) &&
      (!filter ||
        filter ===
          (discovering
            ? typeOf(file.extension).name
            : categories.get(file.fileId))),
  );
  if (sort === "name")
    visibleFiles.sort((a, b) => a.displayName.localeCompare(b.displayName));
  if (sort === "size")
    visibleFiles.sort((a, b) => (b.sizeBytes ?? -1) - (a.sizeBytes ?? -1));
  const knownSizes = files.filter((file) => file.sizeBytes !== undefined);
  const aggregate = knownSizes.reduce(
    (sum, file) => sum + (file.sizeBytes ?? 0),
    0,
  );
  const [expanded, setExpanded] = useState(true);
  const retryIds = batch.filter((id) => {
    const item = progress[id];
    return (
      item &&
      (item.state === "cancelled" ||
        item.state === "skipped" ||
        (item.state === "finished" && "error" in item.attempt))
    );
  });
  const pendingSelection = selection.filter((id) => {
    const item = progress[id];
    return item?.state !== "finished" || !("result" in item.attempt);
  });
  const configure = !stage && needsKey(failure);
  const batchHeading = running
    ? "Analyzing files…"
    : cancelledRun || cancelled
      ? "Analysis cancelled"
      : success === batch.length
        ? "Analysis complete"
        : success
          ? "Analysis partially complete"
          : "Analysis incomplete";
  const usageDetails = (
    <details className="usage-details">
      <summary>
        Session usage and estimates{" "}
        <span>
          Est. cost <b>{displayMoney(usage.estimated)}</b>
        </span>
      </summary>
      <p>
        File analysis session · {usage.input} input / {usage.output} output
        tokens · {usage.cached} cached · {usage.reasoning} reasoning ·{" "}
        {usage.upperEstimate ? "includes upper estimates" : "estimated"}{" "}
        {money(usage.estimated)}.
      </p>
      <p>
        Provisional reserves {money(usage.reserved + usage.inFlight)} ·{" "}
        {usage.unresolved} unreconciled sends · {usage.ambiguous} ambiguous
        attempts. The threshold is a local control and provider charges can
        differ.
      </p>
    </details>
  );
  return (
    <section aria-label="Semantic file analysis">
      {openedReview && (
        <div
          hidden={!review}
          ref={reviewContent}
          tabIndex={-1}
          data-flip-id="analysis-review"
        >
          <ReviewPreview
            files={files}
            progress={progress}
            onBack={() => onReview(false)}
            folder={folder}
            entries={entries}
            busy={deviceBusy}
            onPreview={onPreview}
            preview={preview}
            onPreviewError={onPreviewError}
            onPreviewLoad={onPreviewLoad}
          />
        </div>
      )}
      <div
        hidden={review}
        className={discovering ? "discover-stage" : undefined}
        ref={discoverStage}
      >
        <div
          ref={analysisVisual}
          data-flip-id="analysis-review"
          className="stage-overview"
        >
          {discovering && (
            <div className="stage-count">
              <strong>{files.length.toLocaleString()}</strong>{" "}
              {files.length === 1 ? "file" : "files"} discovered
              {knownSizes.length > 0 && (
                <small>
                  {fileSize(aggregate)}
                  {knownSizes.length === files.length
                    ? " total"
                    : " of known file sizes"}
                </small>
              )}
            </div>
          )}
          {!discovering && batch.length > 0 && (
            <div
              className="analysis-progress"
              data-phase={
                running
                  ? "running"
                  : cancelledRun || cancelled
                    ? "cancelled"
                    : success === batch.length
                      ? "complete"
                      : success
                        ? "partial"
                        : "failed"
              }
            >
              <div className="analysis-progress-heading">
                <strong>{batchHeading}</strong>
                <span>
                  {running
                    ? `${success} of ${batch.length} analyzed · ${settled} settled`
                    : `${success} of ${batch.length} analyzed`}
                </span>
              </div>
              {running && (
                <progress
                  aria-label="Files settled"
                  value={settled}
                  max={batch.length}
                />
              )}
              <p className="outcome-row" role="status">
                <span data-outcome="successful">
                  ✓ <b>{success}</b> successful
                </span>
                <span data-outcome="failed">
                  × <b>{failed}</b> failed
                </span>
                <span data-outcome="skipped">
                  » <b>{skipped}</b> skipped
                </span>
                <span data-outcome="cancelled">
                  ⊘ <b>{cancelled}</b> cancelled
                </span>
                {running && (
                  <span data-outcome="processing">
                    ◌ <b>{processing}</b> processing ·{" "}
                    {batch.length - settled - processing} queued
                  </span>
                )}
                {uncertain > 0 && <span>{uncertain} uncertain</span>}
              </p>
            </div>
          )}
          <DistributionBreakdown
            label={discovering ? "File types" : "Semantic categories"}
            groups={[...groups.values()]}
            active={filter}
            motion={motionEnabled && !review}
            onFilter={(value) => {
              setPage(0);
              setFilter(value);
            }}
          />
        </div>
        <FilesystemBrowser
          title={discovering ? "Files" : "Analysis files"}
          query={query}
          onSearch={(value) => {
            setQuery(value);
            setPage(0);
          }}
          controls={
            <select
              aria-label="Sort files"
              value={sort}
              onChange={(event) => {
                setSort(event.target.value);
                setPage(0);
              }}
            >
              <option value="listing">Listing order</option>
              <option value="name">Name</option>
              <option value="size">Size</option>
            </select>
          }
          footer={
            (!discovering ||
              Boolean(filter || query.trim()) ||
              visibleFiles.length > rowPageSize) && (
              <>
                <span>{visibleFiles.length} items</span>
                {visibleFiles.length > rowPageSize && (
                  <div>
                    <button disabled={!page} onClick={() => setPage(page - 1)}>
                      Previous
                    </button>{" "}
                    <button
                      disabled={(page + 1) * rowPageSize >= visibleFiles.length}
                      onClick={() => setPage(page + 1)}
                    >
                      Next
                    </button>
                  </div>
                )}
              </>
            )
          }
        >
          <details
            open={expanded}
            onToggle={(event) => setExpanded(event.currentTarget.open)}
          >
            <summary>{folder}</summary>
            <ul className="browser-files">
              {visibleFiles
                .slice(page * rowPageSize, (page + 1) * rowPageSize)
                .map((file) => {
                  const id = file.fileId;
                  const outcome = progress[id];
                  const result =
                    outcome?.state === "finished" && "result" in outcome.attempt
                      ? outcome.attempt.result
                      : undefined;
                  const error =
                    outcome?.state === "finished" && "error" in outcome.attempt
                      ? outcome.attempt.error
                      : undefined;
                  const entry = entries.find((item) => item.fileId === id);
                  const nameSuggestion =
                    result && entry?.status === "ready"
                      ? suggestedName(result.suggestedStem, entry)
                      : null;
                  const state = result
                    ? "Analyzed"
                    : error
                      ? error.code === "cancelled"
                        ? "Cancelled"
                        : "Failed"
                      : entry?.status === "excluded"
                        ? "Excluded"
                        : outcome?.state === "analyzing"
                          ? "Analyzing…"
                          : outcome?.state === "queued"
                            ? "Queued"
                            : outcome?.state === "skipped"
                              ? "Skipped"
                              : outcome?.state === "cancelled"
                                ? "Cancelled"
                                : stage === "checking" && selection.includes(id)
                                  ? "Preparing…"
                                  : "Eligibility checked at preparation";
                  return (
                    <li key={id} className="browser-row">
                      {discovering && (
                        <input
                          aria-label={`Select ${file.displayName}`}
                          data-selection-id={id}
                          type="checkbox"
                          checked={selection.includes(id)}
                          disabled={
                            Boolean(stage) ||
                            deviceBusy ||
                            (!selection.includes(id) &&
                              selection.length >= fileAnalysisPolicy.selection)
                          }
                          onChange={() => toggle(id)}
                        />
                      )}
                      <button
                        className="browser-file"
                        aria-pressed={inspected === id}
                        onClick={() =>
                          setInspected(inspected === id ? undefined : id)
                        }
                      >
                        <FileTypeIcon tone={typeOf(file.extension).tone} />
                        <span>
                          {file.displayName}
                          {result && !discovering && (
                            <small>{result.summary}</small>
                          )}
                        </span>
                      </button>
                      {(!discovering || file.sizeBytes !== undefined) && (
                        <span>{fileSize(file.sizeBytes)}</span>
                      )}
                      <small>
                        {!discovering
                          ? [state, categories.get(id), nameSuggestion]
                              .filter(Boolean)
                              .join(" · ")
                          : entry?.status === "excluded"
                            ? "Excluded"
                            : ""}
                      </small>
                      {inspected === id && (
                        <div className="browser-inspection">
                          <p>
                            {error
                              ? failureMessage(error.code)
                              : entry
                                ? description(entry)
                                : state}
                          </p>
                          {result && (
                            <p>
                              {[
                                result.semanticType,
                                result.likelyPurpose,
                                ...result.uncertainty,
                              ]
                                .filter(Boolean)
                                .join(" · ")}
                            </p>
                          )}
                          {/^(png|jpe?g)$/i.test(file.extension ?? "") && (
                            <button
                              disabled={deviceBusy || Boolean(stage)}
                              onClick={() => onPreview(id, file.displayName)}
                            >
                              Preview image
                            </button>
                          )}
                          {preview?.fileId === id && (
                            <img
                              src={preview.url}
                              alt={file.displayName}
                              onLoad={onPreviewLoad}
                              onError={onPreviewError}
                            />
                          )}
                        </div>
                      )}
                    </li>
                  );
                })}
            </ul>
            {!visibleFiles.length && <p>No matching files.</p>}
          </details>
        </FilesystemBrowser>
        <div className={discovering ? "discover-actions" : "workflow-dock"}>
          {!discovering && !stage && (
            <button
              onClick={() => {
                setFilter(undefined);
                setPage(0);
                onDiscover();
              }}
            >
              Back to Discover
            </button>
          )}
          <div className="analysis-actions" hidden={discovering && !stage}>
            {!discovering && (
              <p className="usage-summary">
                Estimated session cost <b>{displayMoney(usage.estimated)}</b>
                {usage.reserved + usage.inFlight > 0 &&
                  ` · Reserved ${displayMoney(usage.reserved + usage.inFlight)}`}
              </p>
            )}
            {stage && (
              <button
                disabled={cancelling}
                onClick={() => {
                  setCancelling(true);
                  operation.current?.abort();
                  if (plan.current) void analysis.port.discard(plan.current);
                  setMessage("Cancelling…");
                }}
              >
                {running ? "Cancel analysis" : "Cancel"}
              </button>
            )}
          </div>
          {(message || (stage && !running)) && (
            <p
              className={
                configure ? "analysis-notice recovery" : "analysis-notice"
              }
              role="status"
            >
              {message ||
                (stage === "checking"
                  ? "Preparing selected files…"
                  : "Waiting for confirmation…")}
            </p>
          )}
          {configure && (
            <div className="recovery-actions">
              <button className="primary" onClick={onConfigure}>
                Configure API key
              </button>
              <button
                onClick={() =>
                  void startAnalysis(retryIds.length ? retryIds : selection)
                }
                disabled={deviceBusy || (!retryIds.length && !selection.length)}
              >
                Try again
              </button>
            </div>
          )}
          {canReview && !discovering && (
            <button
              className={configure ? undefined : "primary"}
              ref={reviewButton}
              onClick={() => {
                if (motionEnabled && analysisVisual.current) {
                  try {
                    flipState.current = Flip.getState(analysisVisual.current);
                  } catch {
                    flipState.current = undefined;
                  }
                }
                setOpenedReview(true);
                onReview(true);
              }}
            >
              Continue to Organize
            </button>
          )}
          {!stage && (
            <div className="analysis-preparation">
              {discovering && !configure && (
                <div className="analysis-cta">
                  <button
                    className="primary"
                    disabled={deviceBusy || !pendingSelection.length}
                    onClick={() => void startAnalysis(pendingSelection)}
                  >
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <path d="M12 2c0 6-4 10-10 10 6 0 10 4 10 10 0-6 4-10 10-10-6 0-10-4-10-10Z" />
                    </svg>
                    Analyze <span aria-hidden="true">→</span>
                  </button>
                </div>
              )}
              {!discovering &&
                batch.length > 0 &&
                retryIds.length > 0 &&
                !configure && (
                  <button
                    className={canReview ? undefined : "primary"}
                    disabled={deviceBusy}
                    onClick={() => void startAnalysis(retryIds)}
                  >
                    Retry remaining files
                  </button>
                )}
              {discovering && (
                <DiscoverPopover
                  label="Analysis options"
                  motion={motionEnabled}
                  above
                  icon={
                    <svg aria-hidden="true" viewBox="0 0 24 24">
                      <path d="M3 7h7m4 0h7M3 17h12m4 0h2M14 7a2 2 0 1 0-4 0 2 2 0 0 0 4 0Zm5 10a2 2 0 1 0-4 0 2 2 0 0 0 4 0Z" />
                    </svg>
                  }
                >
                  <>
                    <strong>Analysis options</strong>
                    <fieldset
                      disabled={Boolean(stage) || deviceBusy}
                      aria-label="Files and budget"
                    >
                      <label className="budget-control">
                        Session budget
                        <select
                          value={budget}
                          onChange={(event) =>
                            setBudget(Number(event.target.value))
                          }
                        >
                          {[5_000_000, 10_000_000, 20_000_000, 50_000_000].map(
                            (limit) => (
                              <option key={limit} value={limit}>
                                {displayMoney(limit)}
                              </option>
                            ),
                          )}
                        </select>
                      </label>
                      <label>
                        <input
                          type="checkbox"
                          checked={imageMode === "original"}
                          onChange={(event) =>
                            setImageMode(
                              event.target.checked ? "original" : "prepared",
                            )
                          }
                        />
                        Send original images with embedded metadata
                      </label>
                    </fieldset>
                    {usageDetails}
                  </>
                </DiscoverPopover>
              )}
            </div>
          )}
        </div>
        {entries.some((entry) => entry.fileId === inspected) && (
          <details className="analysis-details">
            <summary>File details and submission coverage</summary>
            <ul>
              {entries
                .filter((entry) => entry.fileId === inspected)
                .map((entry) => {
                  const current = progress[entry.fileId];
                  const attempt =
                    current?.state === "finished" ? current.attempt : undefined;
                  const value =
                    attempt && "result" in attempt ? attempt.result : undefined;
                  const proposal =
                    value && entry.status === "ready"
                      ? suggestedName(value.suggestedStem, entry)
                      : null;
                  const error =
                    attempt && "error" in attempt ? attempt.error : undefined;
                  const usage = attempt?.metrics?.usage;
                  const cost = attempt?.metrics?.cost;
                  return (
                    <li key={entry.fileId}>
                      <strong>{entry.name}</strong>
                      <p>
                        {entry.status === "ready" && (
                          <strong>Submission coverage · </strong>
                        )}
                        {description(entry)}
                      </p>
                      {current && (
                        <p>
                          {current.state === "finished"
                            ? error
                              ? failureMessage(error.code)
                              : "Complete"
                            : current.state}
                        </p>
                      )}
                      {value && entry.status === "ready" && (
                        <>
                          <h3>Model interpretation</h3>
                          <p>
                            Use the submission coverage above for what was sent.
                            Model descriptions of coverage can be mistaken.
                          </p>
                          <ModelText text={value.summary} />
                          <dl>
                            <dt>Presentation</dt>
                            <dd>{value.presentation}</dd>
                            <dt>Semantic content</dt>
                            <dd>
                              {
                                <ModelText
                                  text={value.semanticType}
                                  limit={60}
                                />
                              }
                            </dd>
                            {value.observations.length > 0 && (
                              <>
                                <dt>Observations</dt>
                                <dd>
                                  <ModelList
                                    values={value.observations}
                                    count={3}
                                    separator=" · "
                                  />
                                </dd>
                              </>
                            )}
                            {value.topic && (
                              <>
                                <dt>Inferred topic</dt>
                                <dd>
                                  {<ModelText text={value.topic} limit={80} />}
                                </dd>
                              </>
                            )}
                            {value.likelyPurpose && (
                              <>
                                <dt>Likely purpose</dt>
                                <dd>
                                  {
                                    <ModelText
                                      text={value.likelyPurpose}
                                      limit={100}
                                    />
                                  }
                                </dd>
                              </>
                            )}
                            {value.tags.length > 0 && (
                              <>
                                <dt>Tags</dt>
                                <dd>
                                  <ModelList
                                    values={value.tags}
                                    count={5}
                                    separator=", "
                                  />
                                </dd>
                              </>
                            )}
                            {value.entities.length > 0 && (
                              <>
                                <dt>Entities</dt>
                                <dd>
                                  <ModelList
                                    values={value.entities}
                                    count={4}
                                    separator=", "
                                  />
                                </dd>
                              </>
                            )}
                            {proposal && (
                              <>
                                <dt>Proposed filename</dt>
                                <dd>{proposal}</dd>
                              </>
                            )}
                            <dt>Sensitivity flags</dt>
                            <dd>
                              {value.sensitivity.join(", ") ||
                                "None reported by the model"}
                            </dd>
                            {value.uncertainty.length > 0 && (
                              <>
                                <dt>Uncertainty</dt>
                                <dd>{value.uncertainty.join(" · ")}</dd>
                              </>
                            )}
                          </dl>
                        </>
                      )}
                      {attempt?.metrics && (
                        <p>
                          {attempt.metrics.elapsedMs} ms ·{" "}
                          {attempt.metrics.diagnostics?.providerStatus ??
                            "Provider status unavailable"}
                          {attempt.metrics.diagnostics?.httpStatus &&
                            ` · HTTP ${attempt.metrics.diagnostics.httpStatus}`}
                        </p>
                      )}
                      {attempt?.metrics?.diagnostics?.validationIssues
                        ?.length ? (
                        <p>
                          {attempt.metrics.diagnostics.validationIssues.some(
                            (issue) => issue.endsWith(": too_big"),
                          )
                            ? "Validation · local safety limit exceeded · "
                            : "Validation · "}
                          {attempt.metrics.diagnostics.validationIssues.join(
                            " · ",
                          )}
                        </p>
                      ) : null}
                      {value && (
                        <p>
                          Normalization ·{" "}
                          {attempt?.metrics?.diagnostics?.normalizedFields?.join(
                            ", ",
                          ) || "None"}
                        </p>
                      )}
                      {usage && (
                        <p>
                          {usage.inputTokens} input / {usage.outputTokens}{" "}
                          output tokens
                          {usage.cachedInputTokens !== undefined &&
                            ` · ${usage.cachedInputTokens} cached`}
                          {usage.reasoningTokens !== undefined &&
                            ` · ${usage.reasoningTokens} reasoning`}
                          {cost &&
                            ` · ${cost.upperEstimate ? "upper estimate" : "estimated"} ${money(cost.nanodollars)}`}
                        </p>
                      )}
                      {attempt?.dispatch !== "local" && attempt && !cost && (
                        <p>
                          {attempt.dispatch === "ambiguous"
                            ? "Dispatch uncertain"
                            : "Dispatched without usable billing data"}
                        </p>
                      )}
                    </li>
                  );
                })}
            </ul>
          </details>
        )}
      </div>
      {!discovering && usageDetails}
    </section>
  );
}
