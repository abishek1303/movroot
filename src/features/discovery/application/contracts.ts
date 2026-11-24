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
  "unknownFile",
  "limitExceeded",
  "resourceChanged",
  "decodeFailed",
]);

export type ScopeId = z.infer<typeof scopeIdSchema>;
export type DeviceScope = z.infer<typeof scopeSchema>;
export type ScopeSelection = z.infer<typeof selectionSchema>;
export type DeviceError = z.infer<typeof deviceErrorSchema>;
export type Result<T> =
  { ok: true; value: T } | { ok: false; error: DeviceError };

export const fileIdSchema = z.string().min(1).max(128).brand<"FileId">();
export const discoverySchema = z.strictObject({
  status: z.enum(["complete", "partial", "truncated", "cancelled"]),
  files: z
    .array(
      z.strictObject({
        fileId: fileIdSchema,
        displayName: z.string().min(1).max(510),
        extension: z.string().min(1).max(32).optional(),
        sizeBytes: z.number().int().nonnegative().optional(),
      }),
    )
    .max(500),
  examined: z.number().int().min(0).max(2000),
  unavailable: z.number().int().min(0).max(2000),
});

export type Discovery = z.infer<typeof discoverySchema>;

export type FileId = z.infer<typeof fileIdSchema>;
export type ReadMode = "content" | "imagePreview";
