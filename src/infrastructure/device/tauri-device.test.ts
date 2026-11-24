import { beforeEach, expect, test, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { scopeIdSchema } from "../../features/discovery/application/contracts";
import { tauriDevice } from "./tauri-device";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
const mockInvoke = vi.mocked(invoke);
const scopeId = scopeIdSchema.parse("d447126b-9f5c-4797-a3cb-b54a150c1cdb");

beforeEach(() => {
  mockInvoke.mockReset();
});

test("validates the native camel-case selection contract", async () => {
  const response = {
    status: "selected",
    scope: { scopeId, label: "Synthetic", capabilities: [] },
  };
  mockInvoke.mockResolvedValue(response);
  expect(await tauriDevice.selectScope()).toEqual({
    ok: true,
    value: response,
  });
  expect(mockInvoke).toHaveBeenCalledWith("select_device_scope", {
    request: {},
  });
});

test("rejects unexpected path fields and normalizes unknown errors", async () => {
  mockInvoke.mockResolvedValue({ status: "cancelled", path: "unexpected" });
  expect(await tauriDevice.selectScope()).toEqual({
    ok: false,
    error: "transportError",
  });
  mockInvoke.mockRejectedValue("scopeInactive");
  expect(await tauriDevice.clearScope(scopeId)).toEqual({
    ok: false,
    error: "scopeInactive",
  });
});

test("keeps cancellation distinct from a failed selection", async () => {
  mockInvoke.mockResolvedValue({ status: "cancelled" });
  expect(await tauriDevice.selectScope()).toEqual({
    ok: true,
    value: { status: "cancelled" },
  });
});
