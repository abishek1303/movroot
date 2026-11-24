import type { Result, ScopeId, ScopeSelection } from "./contracts";

export interface DeviceAdapter {
  selectScope(): Promise<Result<ScopeSelection>>;
  clearScope(scopeId: ScopeId): Promise<Result<void>>;
}
