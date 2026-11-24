import { invoke } from "@tauri-apps/api/core";
import {
  deviceErrorSchema,
  scopeIdSchema,
  selectionSchema,
} from "../../features/discovery/application/contracts";
import type { DeviceAdapter } from "../../features/discovery/application/device";

function normalizeError(value: unknown) {
  const error = deviceErrorSchema.safeParse(value);
  return error.success ? error.data : "transportError";
}

export const tauriDevice: DeviceAdapter = {
  async selectScope() {
    try {
      const response = selectionSchema.safeParse(
        await invoke("select_device_scope", { request: {} }),
      );
      return response.success
        ? { ok: true, value: response.data }
        : { ok: false, error: "transportError" };
    } catch (error) {
      return { ok: false, error: normalizeError(error) };
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
      return response === null || response === undefined
        ? { ok: true, value: undefined }
        : { ok: false, error: "transportError" };
    } catch (error) {
      return { ok: false, error: normalizeError(error) };
    }
  },
};
