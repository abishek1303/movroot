import type { Discovery, Result, ScopeId, ScopeSelection } from "./contracts";

export interface DeviceAdapter {
  selectScope(): Promise<Result<ScopeSelection>>;
  discover(scopeId: ScopeId, signal: AbortSignal): Promise<Result<Discovery>>;
  clearScope(scopeId: ScopeId): Promise<Result<void>>;
}
