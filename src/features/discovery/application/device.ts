import type {
  Discovery,
  FileId,
  ReadMode,
  Result,
  ScopeId,
  ScopeSelection,
} from "./contracts";

export interface DeviceAdapter {
  selectScope(): Promise<Result<ScopeSelection>>;
  discover(scopeId: ScopeId, signal: AbortSignal): Promise<Result<Discovery>>;
  readFile(
    scopeId: ScopeId,
    fileId: FileId,
    mode: ReadMode,
    maxBytes: number,
    signal: AbortSignal,
  ): Promise<Result<Uint8Array>>;
  clearScope(scopeId: ScopeId): Promise<Result<void>>;
}
