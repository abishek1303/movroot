import { z } from "zod";
import {
  deviceErrorSchema,
  fileIdSchema,
} from "../../discovery/application/contracts";

const bytes = z.number().int().nonnegative();
const dimensions = z.tuple([
  z.number().int().positive(),
  z.number().int().positive(),
]);
export type ImageMode = "prepared" | "original";
export const coverageSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("original"),
    sourceBytes: bytes,
    dimensions: dimensions.nullable(),
  }),
  z.strictObject({
    kind: z.literal("text"),
    sourceBytes: bytes,
    coveredBytes: bytes,
    transmittedBytes: bytes,
    bomRemoved: z.boolean(),
    lineEndingsNormalized: z.boolean(),
  }),
  z.strictObject({
    kind: z.literal("image"),
    original: dimensions,
    transmitted: dimensions,
    resized: z.boolean(),
    orientationApplied: z.boolean(),
    sourceBytes: bytes,
    transmittedBytes: bytes,
  }),
]);
const entry = { fileId: fileIdSchema, name: z.string(), extension: z.string() };
const statuses = z.discriminatedUnion("status", [
  z.strictObject({
    ...entry,
    status: z.literal("ready"),
    format: z.enum(["png", "jpeg", "text", "markdown", "json", "csv", "pdf"]),
    coverage: coverageSchema,
  }),
  z.strictObject({
    ...entry,
    status: z.literal("excluded"),
    error: deviceErrorSchema,
  }),
]);
export const manifestSchema = z.strictObject({
  planId: z.uuid(),
  items: z.array(statuses).max(5),
});
export type Manifest = z.infer<typeof manifestSchema>;
export type Entry = Manifest["items"][number];
export type Ready = Extract<Entry, { status: "ready" }>;

export const semanticShape = z.strictObject({
  presentation: z.enum([
    "screenshot",
    "photo",
    "illustration",
    "document",
    "table",
    "data",
    "other",
    "unknown",
  ]),
  semanticType: z.string(),
  summary: z.string(),
  observations: z.array(z.string()),
  topic: z.string().nullable(),
  likelyPurpose: z.string().nullable(),
  tags: z.array(z.string()),
  entities: z.array(z.string()),
  suggestedStem: z.string().nullable(),
  sensitivity: z.array(
    z.enum([
      "personalData",
      "credentials",
      "financial",
      "health",
      "confidentialBusiness",
    ]),
  ),
  uncertainty: z.array(z.string()),
});

// The wire shape checks structure. These larger bounds limit local processing.
const prose = z.string().max(2048).trim().min(1);
const proseList = z.array(prose).max(32);

export const semanticAnalysis = semanticShape.extend({
  semanticType: prose,
  summary: prose,
  observations: proseList,
  topic: prose.nullable(),
  likelyPurpose: prose.nullable(),
  tags: proseList.transform((tags) => [
    ...new Set(tags.map((tag) => tag.toLowerCase())),
  ]),
  entities: proseList,
  suggestedStem: semanticShape.shape.suggestedStem.transform(normalizeStem),
  sensitivity: semanticShape.shape.sensitivity
    .max(32)
    .transform((flags) => [...new Set(flags)]),
  uncertainty: proseList,
});

function normalizeStem(value: string | null) {
  if (value && value.length > 256) return null;
  const stem = value?.normalize("NFC").trim().replace(/ +/g, " ");
  if (
    !stem ||
    !/^[\p{L}\p{N}][\p{L}\p{N}\p{M} _-]{0,79}$/u.test(stem) ||
    /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])$/i.test(stem)
  )
    return null;
  return stem;
}

export function suggestedName(stem: string | null, file: Ready) {
  if (!stem || !file.extension) return stem;
  return /^[\p{L}\p{N}\p{M}_-]{1,80}$/u.test(file.extension)
    ? `${stem}.${file.extension}`
    : null;
}

export function formatMismatch(file: Ready) {
  const suffix = file.extension.toLowerCase();
  if (!suffix) return false;
  if (file.format === "pdf") return suffix !== "pdf";
  return file.format === "png"
    ? suffix !== "png"
    : file.format === "jpeg" && suffix !== "jpg" && suffix !== "jpeg";
}

export type SemanticFileAnalysis = z.infer<typeof semanticAnalysis>;
