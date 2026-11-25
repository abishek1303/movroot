import { useEffect, useRef, useState } from "react";
import type {
  Discovery,
  FileId,
  ScopeId,
} from "../../discovery/application/contracts";
import { formatMismatch, suggestedName } from "../application/contracts";
import type { Entry, Manifest, Ready } from "../application/contracts";
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
          pdfDeferred: "PDF analysis is deferred.",
          unsupportedResource: "Unsupported format.",
          limitExceeded: "File exceeds preparation limits.",
          decodeFailed: "Malformed content or unsupported encoding.",
          resourceChanged: "File changed. Refresh the listing and check again.",
        } as Record<string, string>
      )[entry.error] ?? `Excluded (${entry.error}).`
    );
  }
  const coverage = entry.coverage;
  const detail =
    coverage.kind === "text"
      ? `${coverage.sourceBytes === coverage.coveredBytes ? "Full text" : "Text excerpt"} · ${coverage.coveredBytes} of ${coverage.sourceBytes} source bytes · ${coverage.transmittedBytes} normalized bytes`
      : `Full frame · ${coverage.original.join(" × ")} → ${coverage.transmitted.join(" × ")} · re-encoded${coverage.resized ? " and resized" : ""} · ${coverage.transmittedBytes} prepared bytes`;
  return `${entry.format.toUpperCase()} · ${detail}${formatMismatch(entry) ? " · extension differs from detected format" : ""}`;
}

export function FileAnalysisPanel({
  analysis,
  scope,
  files,
  deviceBusy,
}: {
  analysis: FileAnalysis;
  scope: ScopeId;
  files: Discovery["files"];
  deviceBusy: boolean;
}) {
  const [selection, setSelection] = useState<FileId[]>([]);
  const [manifest, setManifest] = useState<Manifest>();
  const [entries, setEntries] = useState<Entry[]>([]);
  const [progress, setProgress] = useState<
    Partial<Record<FileId, FileProgress>>
  >({});
  const [stage, setStage] = useState<"checking" | "reviewing" | "running">();
  const [message, setMessage] = useState("");
  const [budget, setBudget] = useState(fileAnalysisPolicy.defaultBudget);
  const operation = useRef<AbortController | undefined>(undefined);
  const plan = useRef<string | undefined>(undefined);
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
    }
  }

  async function send() {
    if (!manifest || !plan.current || operation.current) return;
    const id = plan.current;
    const controller = new AbortController();
    operation.current = controller;
    setStage("reviewing");
    setMessage("");
    try {
      const approved = await analysis.port.approve(id);
      if (!approved || controller.signal.aborted) {
        setMessage("Transmission cancelled.");
        return;
      }
      const items = manifest.items.filter(eligible);
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
  return (
    <section aria-label="Semantic file analysis">
      <h2>Analyze files</h2>
      <fieldset disabled={Boolean(stage) || deviceBusy}>
        <legend>Select up to {fileAnalysisPolicy.selection} files</legend>
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
          <p>
            Meta Model API receives the prepared content from eligible files
            after you approve. Processing may incur API charges.
          </p>
          <button
            disabled={
              Boolean(stage) ||
              deviceBusy ||
              !reviewReady ||
              !manifest.items.some(eligible)
            }
            onClick={() => void send()}
          >
            Review and send to Meta
          </button>
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
                  <p>{description(entry)}</p>
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
                      <p>{value.summary}</p>
                      <dl>
                        <dt>Presentation</dt>
                        <dd>{value.presentation}</dd>
                        <dt>Semantic content</dt>
                        <dd>{value.semanticType}</dd>
                        {value.observations.length > 0 && (
                          <>
                            <dt>Observations</dt>
                            <dd>{value.observations.join(" · ")}</dd>
                          </>
                        )}
                        {value.topic && (
                          <>
                            <dt>Inferred topic</dt>
                            <dd>{value.topic}</dd>
                          </>
                        )}
                        {value.likelyPurpose && (
                          <>
                            <dt>Likely purpose</dt>
                            <dd>{value.likelyPurpose}</dd>
                          </>
                        )}
                        {value.tags.length > 0 && (
                          <>
                            <dt>Tags</dt>
                            <dd>{value.tags.join(", ")}</dd>
                          </>
                        )}
                        {value.entities.length > 0 && (
                          <>
                            <dt>Entities</dt>
                            <dd>{value.entities.join(", ")}</dd>
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
                  {attempt?.metrics?.diagnostics?.validationIssues?.length ? (
                    <p>
                      Validation ·{" "}
                      {attempt.metrics.diagnostics.validationIssues.join(" · ")}
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
                      {usage.inputTokens} input / {usage.outputTokens} output
                      tokens
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
        </>
      )}
      {stage && (
        <button
          onClick={() => {
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
    </section>
  );
}
