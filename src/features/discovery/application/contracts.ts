import { z } from "zod";

export const scopeIdSchema = z.string().min(1).max(128).brand<"ScopeId">();
export const scopeSchema = z.strictObject({
  scopeId: scopeIdSchema,
  label: z.string().min(1).max(510),
  capabilities: z.array(z.enum(["discover", "read"])).max(2),
});
export const selectionSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("selected"), scope: scopeSchema }),
  z.strictObject({ status: z.literal("cancelled") }),
]);
export const deviceErrorSchema = z.enum([
  "invalidRequest",
  "scopeInactive",
  "unsupportedResource",
  "permissionDenied",
  "busy",
  "cancelled",
  "unavailable",
  "transportError",
]);

export type ScopeId = z.infer<typeof scopeIdSchema>;
export type DeviceScope = z.infer<typeof scopeSchema>;
export type ScopeSelection = z.infer<typeof selectionSchema>;
export type DeviceError = z.infer<typeof deviceErrorSchema>;
export type Result<T> =
  { ok: true; value: T } | { ok: false; error: DeviceError };
