import { AnalysisMotion } from "../../../components/motion/AnalysisMotion";
import { Flip, useGSAP } from "../../../components/motion/engine";
import { createMotionFeed } from "../../../components/motion/signals";
import { analysisMotionSignal } from "./analysisMotionSignal";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type {
  Discovery,
  FileId,
  ScopeId,
} from "../../discovery/application/contracts";
import { formatMismatch, suggestedName } from "../application/contracts";
import type {
  Entry,
  ImageMode,
  Manifest,
  Ready,
} from "../application/contracts";
import { ReviewPreview } from "./ReviewPreview";
import { fileAnalysisPolicy } from "../application/workflow";
import type { FileAnalysis, FileProgress } from "../application/workflow";

const money = (nanodollars: number) =>
  `$${(nanodollars / 1_000_000_000).toFixed(9)}`;
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

export function FileAnalysisPanel({
  analysis,
  scope,
  files,
  deviceBusy,
  review,
  onReview,
  onBusy,
  motionEnabled,
  onAnalysisStarted,
  folder,
  onPreview,
  preview,
  onPreviewError,
  onPreviewLoad,
}: {
  analysis: FileAnalysis;
  scope: ScopeId;
  files: Discovery["files"];
  deviceBusy: boolean;
  review: boolean;
  onReview: (review: boolean) => void;
  onBusy: (busy: boolean) => void;
  motionEnabled: boolean;
  onAnalysisStarted: () => void;
  folder: string;
  onPreview: (id: FileId, name: string) => void;
  preview?: { url: string; fileId: FileId };
  onPreviewError: () => void;
  onPreviewLoad: () => void;
}) {
  const [selection, setSelection] = useState<FileId[]>([]);
  const [manifest, setManifest] = useState<Manifest>();
  const [entries, setEntries] = useState<Entry[]>([]);
  const [progress, setProgress] = useState<
    Partial<Record<FileId, FileProgress>>
  >({});
  const [stage, setStage] = useState<"checking" | "reviewing" | "running">();
  const [message, setMessage] = useState("");
  const [imageMode, setImageMode] = useState<ImageMode>("prepared");
  const [budget, setBudget] = useState(fileAnalysisPolicy.defaultBudget);
  const operation = useRef<AbortController | undefined>(undefined);
  const plan = useRef<string | undefined>(undefined);
  const [feed] = useState(createMotionFeed);
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
  const [reviewReady, setReviewReady] = useState(false);
  useEffect(
    () => () => {
      operation.current?.abort();
      if (plan.current) void analysis.port.discard(plan.current);
    },
    [analysis],
  );

  async function prepare() {
    if (operation.current) return;
    const controller = new AbortController();
    operation.current = controller;
    onBusy(true);
    setStage("checking");
    setMessage("");
    try {
      if (plan.current) await analysis.port.discard(plan.current);
      plan.current = undefined;
      setReviewReady(false);
      const result = await analysis.port.prepare(
        scope,
        selection,
        controller.signal,
        imageMode,
      );
      if ("manifest" in result) {
        plan.current = result.manifest.planId;
        setReviewReady(true);
        setManifest(result.manifest);
        setEntries((previous) => [
          ...previous.filter(
            (entry) =>
              !result.manifest.items.some(
                (item) => item.fileId === entry.fileId,
              ),
          ),
          ...result.manifest.items,
        ]);
      } else
        setMessage(
          `File check ${result.error === "cancelled" ? "cancelled" : `failed (${result.error})`}.`,
        );
    } finally {
      operation.current = undefined;
      setStage(undefined);
      onBusy(false);
    }
  }

  async function send() {
    if (!manifest || !plan.current || operation.current) return;
    const id = plan.current;
    const controller = new AbortController();
    operation.current = controller;
    onBusy(true);
    setCancelling(false);
    setStage("reviewing");
    setMessage("");
    try {
      const approved = await analysis.port.approve(id);
      if (!approved || controller.signal.aborted) {
        setMessage("Transmission cancelled.");
        return;
      }
      const items = manifest.items.filter(eligible);
      setReviewReady(false);
      onAnalysisStarted();
      setBatch(items.map(({ fileId }) => fileId));
      setProgress((previous) => ({
        ...previous,
        ...Object.fromEntries(
          items.map(({ fileId }) => [fileId, { state: "queued" }]),
        ),
      }));
      setStage("running");
      const status = await analysis.run(
        id,
        items,
        budget,
        controller.signal,
        (file, value) => {
          setProgress((previous) => ({ ...previous, [file]: value }));
          const signal = analysisMotionSignal(value);
          if (signal) feed.emit(file, signal);
        },
      );
      setMessage(
        controller.signal.aborted
          ? "Remaining work cancelled. Meta may still process a dispatched request."
          : status,
      );
    } catch {
      setMessage("Review was interrupted or expired. Check the files again.");
    } finally {
      await analysis.port.discard(id);
      plan.current = undefined;
      setReviewReady(false);
      operation.current = undefined;
      setStage(undefined);
      onBusy(false);
    }
  }

  function toggle(file: FileId) {
    setSelection((previous) =>
      previous.includes(file)
        ? previous.filter((id) => id !== file)
        : [...previous, file],
    );
    if (plan.current) void analysis.port.discard(plan.current);
    plan.current = undefined;
    setReviewReady(false);
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
  const visibleCategories = new Set<string>();
  let uncertain = 0;
  for (const outcome of outcomes) {
    if (!outcome) continue;
    const signal = analysisMotionSignal(outcome);
    if (signal?.kind === "classified") visibleCategories.add(signal.category);
    if (signal?.kind === "uncertain") uncertain++;
  }
  const hasResults = Object.values(progress).some(
    (item) => item?.state === "finished" && "result" in item.attempt,
  );
  const canReview = hasResults && !stage && !deviceBusy;
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
      <div hidden={review}>
        <div
          className="analysis-visual"
          ref={analysisVisual}
          data-flip-id="analysis-review"
          hidden={batch.length === 0}
        >
          <AnalysisMotion
            feed={feed}
            categories={[...visibleCategories]}
            remaining={
              outcomes.filter(
                (item) =>
                  item?.state === "queued" || item?.state === "analyzing",
              ).length
            }
            enabled={motionEnabled && !review}
            active={!cancelling}
          />
        </div>
        {batch.length > 0 && (
          <div className="analysis-progress">
            <label>
              Analysis progress{" "}
              <progress
                value={success + failed + cancelled + skipped}
                max={batch.length}
              />
            </label>
            <p role="status">
              {success + failed} of {batch.length} processed · {success}{" "}
              successful · {failed} failed · {skipped} skipped · {cancelled}{" "}
              cancelled{uncertain > 0 ? ` · ${uncertain} uncertain` : ""}
            </p>
            <p className="usage-summary">
              Estimated session usage {money(usage.estimated)}
              {usage.reserved + usage.inFlight > 0 &&
                ` · Reserved ${money(usage.reserved + usage.inFlight)}`}
            </p>
          </div>
        )}
        <div className="analysis-actions">
          {stage && (
            <button
              onClick={() => {
                setCancelling(true);
                operation.current?.abort();
                if (plan.current) void analysis.port.discard(plan.current);
                setMessage("Cancelling…");
              }}
            >
              Cancel
            </button>
          )}
          <p role="status">
            {message ||
              (stage === "checking"
                ? "Checking files locally…"
                : stage === "running"
                  ? "Analyzing selected files…"
                  : stage === "reviewing"
                    ? "Waiting for confirmation…"
                    : "")}
          </p>
        </div>
        {canReview && (
          <button
            className="primary"
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
            Review changes
          </button>
        )}
        <fieldset
          hidden={stage === "running"}
          disabled={Boolean(stage) || deviceBusy}
        >
          <legend>Files to analyze</legend>
          <p>
            {selection.length} selected · Current batch limit{" "}
            {fileAnalysisPolicy.selection}
          </p>
          <div className="file-selection">
            {files.map((file) => (
              <label key={file.fileId} style={{ display: "block" }}>
                <input
                  type="checkbox"
                  checked={selection.includes(file.fileId)}
                  disabled={
                    !selection.includes(file.fileId) &&
                    selection.length >= fileAnalysisPolicy.selection
                  }
                  onChange={() => toggle(file.fileId)}
                />
                {file.displayName}
              </label>
            ))}
          </div>
          <label>
            <input
              type="checkbox"
              checked={imageMode === "original"}
              onChange={(event) => {
                setImageMode(event.target.checked ? "original" : "prepared");
                if (plan.current) void analysis.port.discard(plan.current);
                plan.current = undefined;
                setReviewReady(false);
              }}
            />
            Send original images with embedded metadata
          </label>
          <button disabled={!selection.length} onClick={() => void prepare()}>
            Check selected files
          </button>
          <label>
            Estimated session threshold
            <select
              value={budget}
              onChange={(event) => setBudget(Number(event.target.value))}
            >
              {[5_000_000, 10_000_000, 20_000_000, 50_000_000].map((limit) => (
                <option key={limit} value={limit}>
                  {money(limit)}
                </option>
              ))}
            </select>
          </label>
        </fieldset>
        {manifest && (
          <>
            {reviewReady && (
              <p>
                Meta Model API receives the prepared content from eligible files
                after you approve. Processing may incur API charges.
              </p>
            )}
            {reviewReady && (
              <button
                className="primary"
                disabled={
                  Boolean(stage) ||
                  deviceBusy ||
                  !reviewReady ||
                  !manifest.items.some(eligible)
                }
                onClick={() => void send()}
              >
                Start analysis
              </button>
            )}
            <details open={reviewReady || undefined}>
              <summary>File details and submission coverage</summary>
              <ul>
                {entries.map((entry) => {
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
                              ? `Failed (${error.code})`
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
          </>
        )}
      </div>
      <details>
        <summary>Session usage and estimates</summary>
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
    </section>
  );
}
