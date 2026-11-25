import type { Failure, InferenceInput, InferenceOutcome } from "./contracts";

export interface InferenceProvider {
  infer(input: InferenceInput, signal: AbortSignal): Promise<InferenceOutcome>;
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: Failure };
export interface CredentialStatus {
  source: "environment" | "secureStore" | "missing";
  remainingDispatches: number;
}

export interface CredentialSettings {
  status(): Promise<Result<CredentialStatus>>;
  save(key: string): Promise<Result<void>>;
  remove(): Promise<Result<void>>;
}
