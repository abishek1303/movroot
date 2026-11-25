import { useEffect, useRef, useState } from "react";
import type { Failure, InferenceOutcome } from "../application/contracts";
import {
  diagnosticInput,
  diagnosticText,
} from "../application/diagnostic-input";
import type {
  CredentialSettings,
  CredentialStatus,
  InferenceProvider,
} from "../application/provider";
import {
  createInferenceSession,
  emptyUsage,
  ESTIMATED_SESSION_LIMIT,
} from "../application/session";

const messages: Partial<Record<Failure["code"], string>> = {
  invalidCredential: "Enter a valid API key.",
  credentialMissing: "Save a Muse Ember API key first.",
  credentialConfiguration: "Could not read the development .env configuration.",
  credentialStore: "The operating system credential store is unavailable.",
  authentication: "Meta rejected the API key.",
  accessDenied: "This project does not have access to Muse Ember.",
  rateLimited: "Meta rate-limited the request.",
  timeout: "The request timed out. Meta may still have processed it.",
  cancelled: "Request cancelled locally. Meta may still have processed it.",
  outputExhausted: "The model reached its output budget.",
  incomplete: "The model did not finish its response.",
  refused: "The model refused to process the example.",
  providerFailed: "The provider reported an inference failure.",
  schemaMismatch: "The response did not match the diagnostic schema.",
  invalidJson: "The model output was not valid JSON.",
  missingOutput: "The response contained no final text.",
  unexpectedOutput: "The response contained an unexpected output type.",
  budgetExceeded: "The diagnostic dispatch budget was reached.",
  staleSession: "Refresh the key status to reconnect to the current window.",
};

function explain(error: Failure): string {
  const message =
    messages[error.code] ?? `Inference operation failed (${error.code}).`;
  return error.retryAfterSeconds == null
    ? message
    : `${message} Try again after ${error.retryAfterSeconds} seconds.`;
}

function usd(nanodollars: number): string {
  return `$${(nanodollars / 1_000_000_000).toFixed(9)}`;
}

export function InferencePanel({
  provider,
  credentials,
}: {
  provider: InferenceProvider;
  credentials: CredentialSettings;
}) {
  const [session] = useState(() => createInferenceSession(provider));
  const keyField = useRef<HTMLInputElement>(null);
  const [status, setStatus] = useState<CredentialStatus>();
  const [busy, setBusy] = useState<"credential" | "inference" | undefined>(
    "credential",
  );
  const [message, setMessage] = useState("");
  const [outcome, setOutcome] = useState<InferenceOutcome>();
  const [usage, setUsage] = useState(emptyUsage);

  useEffect(() => {
    let disposed = false;
    let timer: number | undefined;
    async function initialize(attemptsLeft: number) {
      const current = await credentials.status();
      if (disposed) return;
      if (current.ok) {
        setStatus(current.value);
      } else if (
        attemptsLeft > 0 &&
        (current.error.code === "staleSession" || current.error.code === "busy")
      ) {
        timer = window.setTimeout(() => void initialize(attemptsLeft - 1), 100);
        return;
      } else {
        setMessage(explain(current.error));
      }
      setBusy(undefined);
    }
    void initialize(10);
    return () => {
      disposed = true;
      window.clearTimeout(timer);
      session.invalidate();
    };
  }, [credentials, session]);

  async function refresh() {
    const current = await credentials.status();
    if (current.ok) setStatus(current.value);
    else setMessage(explain(current.error));
  }

  async function update(action: "status" | "save" | "remove") {
    setBusy("credential");
    setMessage("");
    const field = keyField.current;
    const key = action === "save" ? (field?.value.trim() ?? "") : "";
    if (action === "save" && field) field.value = "";
    try {
      if (action === "status" || !status) {
        const current = await credentials.status();
        if (!current.ok) {
          setMessage(explain(current.error));
          return;
        }
        setStatus(current.value);
        if (action === "status") return;
      }
      let result;
      if (action === "save") {
        result = await credentials.save(key);
      } else {
        result = await credentials.remove();
        session.invalidate();
        setOutcome(undefined);
      }
      if (!result.ok) setMessage(explain(result.error));
      await refresh();
    } finally {
      setBusy(undefined);
    }
  }

  async function run(kind: "text" | "image") {
    setBusy("inference");
    setMessage("");
    setOutcome(undefined);
    try {
      const result = await session.run(diagnosticInput(kind));
      if (!result) return;
      setUsage(result.usage);
      setOutcome(result.outcome);
      if (!result.outcome.ok) setMessage(explain(result.outcome.error));
      await refresh();
    } finally {
      setBusy(undefined);
    }
  }

  const disabled =
    Boolean(busy) ||
    !status ||
    status.source === "missing" ||
    status.remainingDispatches === 0 ||
    usage.estimatedNanodollars >= ESTIMATED_SESSION_LIMIT;
  const metrics = outcome?.metrics;
  return (
    <section aria-label="Muse Ember diagnostics">
      <h2>Muse Ember diagnostics</h2>
      <p>
        {status?.source === "environment"
          ? "Using the development environment credential. It takes precedence over stored credentials."
          : status?.source === "secureStore"
            ? "API key stored."
            : status?.source === "missing"
              ? "No API key stored."
              : "API key status unknown."}
        {status &&
          ` ${status.remainingDispatches} diagnostic attempts remaining.`}
      </p>
      {status?.source !== "environment" && (
        <>
          <label>
            Meta API key{" "}
            <input
              type="password"
              ref={keyField}
              autoComplete="off"
              maxLength={1024}
              disabled={Boolean(busy)}
            />
          </label>
          <button disabled={Boolean(busy)} onClick={() => update("save")}>
            Save API key
          </button>
          <button
            disabled={Boolean(busy) || status?.source !== "secureStore"}
            onClick={() => update("remove")}
          >
            Remove API key
          </button>
        </>
      )}
      <button disabled={Boolean(busy)} onClick={() => update("status")}>
        Refresh key status
      </button>
      <p>
        Each request sends one bundled example to Meta using your project
        credits.
      </p>
      <details>
        <summary>Synthetic examples</summary>
        <p>{diagnosticText}</p>
        <p>
          The image is a 64 × 64 illustration of an orange circle on a blue
          background.
        </p>
      </details>
      <button disabled={disabled} onClick={() => run("text")}>
        Send text to Meta
      </button>
      <button disabled={disabled} onClick={() => run("image")}>
        Send image to Meta
      </button>
      <button disabled={busy !== "inference"} onClick={() => session.cancel()}>
        Cancel inference
      </button>
      <p role="status">
        {busy === "inference" ? "Waiting for Muse Ember…" : message}
      </p>
      {outcome?.ok && (
        <dl>
          <dt>Summary</dt>
          <dd>{outcome.value.summary}</dd>
          <dt>Category</dt>
          <dd>{outcome.value.category}</dd>
          <dt>Tags</dt>
          <dd>{outcome.value.tags.join(", ") || "None"}</dd>
          <dt>Uncertainty</dt>
          <dd>{outcome.value.uncertainty.join(" ") || "None reported"}</dd>
        </dl>
      )}
      {metrics && (
        <dl>
          <dt>Model</dt>
          <dd>{metrics.model}</dd>
          <dt>Elapsed</dt>
          <dd>{metrics.elapsedMs} ms</dd>
          <dt>Input / output tokens</dt>
          <dd>
            {metrics.usage
              ? `${metrics.usage.inputTokens} / ${metrics.usage.outputTokens}`
              : "Unknown"}
          </dd>
          {metrics.usage && (
            <>
              <dt>Cached input / reasoning tokens</dt>
              <dd>
                {metrics.usage.cachedInputTokens ?? "Unknown"} /{" "}
                {metrics.usage.reasoningTokens ?? "Unknown"}
              </dd>
            </>
          )}
          <dt>Estimated request cost</dt>
          <dd>
            {metrics.cost
              ? `${usd(metrics.cost.nanodollars)}${metrics.cost.upperEstimate ? " (upper estimate)" : ""}`
              : "Unknown"}
          </dd>
        </dl>
      )}
      {metrics?.diagnostics && (
        <details>
          <summary>Request diagnostics</summary>
          <dl>
            {outcome && !outcome.ok && (
              <>
                <dt>Error category</dt>
                <dd>{outcome.error.code}</dd>
              </>
            )}
            {Object.entries(metrics.diagnostics)
              .filter(([, value]) => value !== undefined)
              .map(([label, value]) => (
                <div key={label}>
                  <dt>
                    {label.replace(
                      /[A-Z]/g,
                      (char) => ` ${char.toLowerCase()}`,
                    )}
                  </dt>
                  <dd>{value}</dd>
                </div>
              ))}
          </dl>
        </details>
      )}
      <p>
        Session estimate for priced responses:{" "}
        {usage.pricedResponses ? usd(usage.estimatedNanodollars) : "Unknown"}
        {usage.includesUpperEstimate ? " (includes upper estimates)" : ""}.
        Unreconciled attempts: {usage.unreconciledAttempts}.
      </p>
      {usage.usageResponses > 0 && (
        <p>
          Reported session tokens: {usage.inputTokens} input /{" "}
          {usage.outputTokens} output.
        </p>
      )}
    </section>
  );
}
