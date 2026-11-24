import { invoke } from "@tauri-apps/api/core";
import {
  deviceErrorSchema,
  discoverySchema,
  scopeIdSchema,
  selectionSchema,
} from "../../features/discovery/application/contracts";
import type { DeviceAdapter } from "../../features/discovery/application/device";

function normalizeError(value: unknown) {
  const error = deviceErrorSchema.safeParse(value);
  return error.success ? error.data : "transportError";
}

let activeScope: { scopeId: string; requestId: number } | undefined;

export const tauriDevice: DeviceAdapter = {
  async selectScope() {
    try {
      const response = selectionSchema.safeParse(
        await invoke("select_device_scope", { request: {} }),
      );
      if (response.success && response.data.status === "selected") {
        activeScope = { scopeId: response.data.scope.scopeId, requestId: 0 };
      }
      return response.success
        ? { ok: true, value: response.data }
        : { ok: false, error: "transportError" };
    } catch (error) {
      return { ok: false, error: normalizeError(error) };
    }
  },

  async discover(scopeId, signal) {
    if (signal.aborted) return { ok: false, error: "cancelled" };
    if (activeScope?.scopeId !== scopeId)
      return { ok: false, error: "scopeInactive" };
    const request = { scopeId, requestId: ++activeScope.requestId };
    const cancel = () => {
      void invoke("cancel_device_operation", { request }).catch(
        () => undefined,
      );
    };
    signal.addEventListener("abort", cancel, { once: true });
    try {
      const response = discoverySchema.safeParse(
        await invoke("discover_device_files", { request }),
      );
      return response.success
        ? { ok: true, value: response.data }
        : { ok: false, error: "transportError" };
    } catch (error) {
      return { ok: false, error: normalizeError(error) };
    } finally {
      signal.removeEventListener("abort", cancel);
    }
  },

  async clearScope(scopeId) {
    if (!scopeIdSchema.safeParse(scopeId).success) {
      return { ok: false, error: "invalidRequest" };
    }
    try {
      const response = await invoke("clear_device_scope", {
        request: { scopeId },
      });
      if (
        (response === null || response === undefined) &&
        activeScope?.scopeId === scopeId
      ) {
        activeScope = undefined;
      }
      return response === null || response === undefined
        ? { ok: true, value: undefined }
        : { ok: false, error: "transportError" };
    } catch (error) {
      return { ok: false, error: normalizeError(error) };
    }
  },
};
