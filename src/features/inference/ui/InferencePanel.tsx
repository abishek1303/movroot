import { useEffect, useRef, useState } from "react";
import type { Failure, InferenceOutcome } from "../application/contracts";
import { diagnosticInput } from "../application/diagnostic-input";
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
  credentialConfiguration: "Could not read the API key configuration.",
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
  staleSession: "Reopen Settings and try again.",
};

function explain(error: Failure): string {
  const message =
    messages[error.code] ?? "The provider operation could not be completed.";
  return error.retryAfterSeconds == null
    ? message
    : `${message} Try again after ${error.retryAfterSeconds} seconds.`;
}

const icons = {
  refresh: "M20 11a8 8 0 1 0-2 6m2-12v6h-6",
  edit: "m4 16-1 5 5-1L20 8l-4-4L4 16Zm10-10 4 4",
  add: "M12 5v14M5 12h14",
  show: "M2 12s4-6 10-6 10 6 10 6-4 6-10 6S2 12 2 12Zm13 0a3 3 0 1 0-6 0 3 3 0 0 0 6 0Z",
  hide: "M3 3l18 18M10 6a12 12 0 0 1 2 0c6 0 10 6 10 6a17 17 0 0 1-4 4M6 7a17 17 0 0 0-4 5s4 6 10 6a12 12 0 0 0 2-.2",
  remove: "M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 10v7m4-7v7",
  save: "m4 12 5 5L20 6",
  close: "m6 6 12 12M18 6 6 18",
} as const;

function Icon({ name }: { name: keyof typeof icons }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <path d={icons[name]} />
    </svg>
  );
}

export function InferencePanel({
  provider,
  credentials,
  visible,
  model,
}: {
  provider: InferenceProvider;
  credentials: CredentialSettings;
  visible: boolean;
  model: string;
}) {
  const [session] = useState(() => createInferenceSession(provider));
  const [editing, setEditing] = useState(false);
  const [showDraft, setShowDraft] = useState(false);
  const [confirmCheck, setConfirmCheck] = useState(false);
  const [status, setStatus] = useState<CredentialStatus>();
  const [busy, setBusy] = useState<"credential" | "inference" | undefined>();
  const [message, setMessage] = useState("");
  const [outcome, setOutcome] = useState<InferenceOutcome>();
  const [usage, setUsage] = useState(emptyUsage);
  const keyField = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!visible) return;
    let disposed = false;
    let timer: number | undefined;
    async function initialize(attemptsLeft: number) {
      const current = await credentials.status();
      if (disposed) return;
      if (current.ok) {
        setStatus(current.value);
      } else if (
        attemptsLeft > 0 &&
        ["staleSession", "busy"].includes(current.error.code)
      ) {
        timer = window.setTimeout(() => void initialize(attemptsLeft - 1), 100);
      } else {
        setMessage(explain(current.error));
      }
    }
    void initialize(10);
    return () => {
      disposed = true;
      window.clearTimeout(timer);
      setEditing(false);
      setShowDraft(false);
      setConfirmCheck(false);
    };
  }, [credentials, visible]);
  useEffect(() => () => session.invalidate(), [session]);

  function editKey() {
    setEditing(true);
    setConfirmCheck(false);
    setShowDraft(false);
    setMessage("");
  }

  function closeEditor() {
    if (keyField.current) keyField.current.value = "";
    setEditing(false);
    setShowDraft(false);
  }

  async function refresh() {
    const current = await credentials.status();
    if (current.ok) setStatus(current.value);
    else setMessage(explain(current.error));
    return current;
  }

  async function update(action: "save" | "remove") {
    if (busy || !status || status.source === "environment") return;
    const key = keyField.current?.value.trim() ?? "";
    if (action === "save" && !key) {
      setMessage("Enter an API key.");
      return;
    }
    if (action === "save") setShowDraft(false);
    setBusy("credential");
    setMessage("");
    try {
      const result =
        action === "save"
          ? await credentials.save(key)
          : await credentials.remove();
      if (result.ok) {
        setOutcome(undefined);
        closeEditor();
      } else {
        setMessage(explain(result.error));
      }
      await refresh();
    } finally {
      setBusy(undefined);
    }
  }

  async function requestCheck() {
    if (busy) return;
    setBusy("credential");
    setMessage("");
    try {
      const current = await refresh();
      if (!current.ok || current.value.source === "missing") {
        if (current.ok) setOutcome(undefined);
        return;
      }
      if (
        !current.value.remainingDispatches ||
        usage.estimatedNanodollars >= ESTIMATED_SESSION_LIMIT
      ) {
        setMessage(
          "The connection check limit has been reached for this session.",
        );
        return;
      }
      setConfirmCheck(true);
    } finally {
      setBusy(undefined);
    }
  }

  async function checkConnection() {
    if (busy) return;
    setConfirmCheck(false);
    setBusy("inference");
    setMessage("");
    setOutcome(undefined);
    try {
      const result = await session.run(diagnosticInput("text"));
      if (result) {
        setUsage(result.usage);
        setOutcome(result.outcome);
        if (!result.outcome.ok) setMessage(explain(result.outcome.error));
      }
      await refresh();
    } finally {
      setBusy(undefined);
    }
  }

  const configured = Boolean(status && status.source !== "missing");
  const effectiveOutcome = configured ? outcome : undefined;
  const health =
    busy === "inference"
      ? "Checking connection…"
      : effectiveOutcome?.ok
        ? "Healthy · last check passed"
        : effectiveOutcome
          ? "Last check failed"
          : configured
            ? "Configured · unchecked"
            : status
              ? "No API key configured"
              : "Key status unavailable";
  const canEdit = status && status.source !== "environment";

  return (
    <section className="provider-panel" aria-label="Meta provider">
      <div className="provider-heading">
        <strong>Meta Model API</strong>
        <span>{model}</span>
      </div>
      <div className="key-health">
        <span
          className="key-health-label"
          role="status"
          data-health={
            busy === "inference"
              ? "pending"
              : effectiveOutcome?.ok
                ? "healthy"
                : effectiveOutcome
                  ? "failed"
                  : "unknown"
          }
        >
          <span className="key-health-dot" aria-hidden="true" />
          {health}
        </span>
        <button
          className="provider-icon"
          aria-label={
            busy === "inference"
              ? "Cancel connection check"
              : "Refresh connection health"
          }
          title={
            busy === "inference"
              ? "Cancel connection check"
              : "Check the connection to Meta"
          }
          disabled={busy === "credential" || Boolean(visible && editing)}
          onClick={() =>
            busy === "inference" ? session.cancel() : void requestCheck()
          }
        >
          <Icon name={busy === "inference" ? "close" : "refresh"} />
        </button>
      </div>
      {visible && editing && canEdit ? (
        <form
          className="credential-form"
          onSubmit={(event) => {
            event.preventDefault();
            void update("save");
          }}
        >
          <label htmlFor="replacement-meta-key">
            {configured ? "Replacement API key" : "Meta API key"}
          </label>
          <div className="key-controls">
            <input
              id="replacement-meta-key"
              type={showDraft ? "text" : "password"}
              ref={keyField}
              autoComplete="new-password"
              spellCheck={false}
              required
              maxLength={1024}
              disabled={Boolean(busy)}
              autoFocus
            />
            <button
              className="provider-icon"
              type="button"
              aria-label={showDraft ? "Hide key" : "Show key"}
              title={showDraft ? "Hide key" : "Show key"}
              onClick={() => setShowDraft(!showDraft)}
            >
              <Icon name={showDraft ? "hide" : "show"} />
            </button>
            <button
              className="provider-icon"
              type="submit"
              aria-label="Save key"
              title="Save key"
              disabled={Boolean(busy)}
            >
              <Icon name="save" />
            </button>
            <button
              className="provider-icon"
              type="button"
              aria-label="Cancel editing"
              title="Cancel editing"
              disabled={Boolean(busy)}
              onClick={closeEditor}
            >
              <Icon name="close" />
            </button>
          </div>
        </form>
      ) : (
        <div className="key-controls">
          {configured ? (
            <span className="masked-key" aria-label="Stored API key is masked">
              ••••••••••••
            </span>
          ) : (
            <span className="key-placeholder">Meta API key</span>
          )}
          {canEdit && (
            <button
              className="provider-icon"
              aria-label={configured ? "Edit key" : "Add key"}
              title={configured ? "Edit key" : "Add key"}
              disabled={Boolean(busy)}
              onClick={editKey}
            >
              <Icon name={configured ? "edit" : "add"} />
            </button>
          )}
          {status?.source === "secureStore" && (
            <button
              className="provider-icon"
              aria-label="Remove key"
              title="Remove key"
              disabled={Boolean(busy)}
              onClick={() => void update("remove")}
            >
              <Icon name="remove" />
            </button>
          )}
        </div>
      )}
      {confirmCheck && visible && !editing && (
        <div className="key-check-confirm">
          <p>
            The check sends a built-in example to Meta and may use API credits.
          </p>
          <div className="folder-toolbar">
            <button
              className="primary"
              onClick={() => void checkConnection()}
              disabled={Boolean(busy)}
            >
              Run check
            </button>
            <button
              className="provider-icon"
              aria-label="Dismiss connection check"
              title="Dismiss"
              onClick={() => setConfirmCheck(false)}
            >
              <Icon name="close" />
            </button>
          </div>
        </div>
      )}
      {status?.source === "environment" && (
        <small className="key-source">
          Managed by the development environment
        </small>
      )}
      {message && (
        <p className="key-message" role="status">
          {message}
        </p>
      )}
    </section>
  );
}
