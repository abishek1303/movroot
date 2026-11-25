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
export const coverageSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("text"),
    sourceBytes: bytes,
    coveredBytes: bytes,
    transmittedBytes: bytes,
  }),
  z.strictObject({
    kind: z.literal("image"),
    original: dimensions,
    transmitted: dimensions,
    resized: z.boolean(),
    transmittedBytes: bytes,
  }),
]);
const entry = { fileId: fileIdSchema, name: z.string(), extension: z.string() };
const statuses = z.discriminatedUnion("status", [
  z.strictObject({
    ...entry,
    status: z.literal("ready"),
    format: z.enum(["png", "jpeg", "text", "markdown", "json", "csv"]),
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

const field = (max: number) => z.string().trim().min(1).max(max);
// Meta's strict wire shape validates types. Bound returned prose before presentation.
const displayField = (max: number) =>
  field(2048).transform((value) => {
    const characters = Array.from(value);
    if (characters.length <= max) return value;
    const prefix = characters.slice(0, max - 1).join("");
    const lastWord = prefix.lastIndexOf(" ");
    return `${lastWord >= Math.floor(max * 0.75) ? prefix.slice(0, lastWord) : prefix}…`;
  });
const displayList = (count: number, max: number) =>
  z
    .array(displayField(max))
    .max(32)
    .transform((values) => values.slice(0, count));

export const semanticAnalysis = semanticShape.extend({
  semanticType: field(60),
  summary: displayField(240),
  observations: displayList(3, 100),
  topic: field(80).nullable(),
  likelyPurpose: field(100).nullable(),
  tags: z
    .array(field(32))
    .max(32)
    .transform((tags) =>
      [...new Set(tags.map((tag) => tag.toLowerCase()))].slice(0, 5),
    ),
  entities: displayList(4, 60),
  suggestedStem: z.string().nullable().transform(normalizeStem),
  sensitivity: semanticShape.shape.sensitivity
    .max(32)
    .transform((flags) => [...new Set(flags)]),
  // Preserve complete caveats. The response and array bounds limit rendering work.
  uncertainty: z.array(field(2048)).max(32),
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
  return file.format === "png"
    ? suffix !== "png"
    : file.format === "jpeg" && suffix !== "jpg" && suffix !== "jpeg";
}

export type SemanticFileAnalysis = z.infer<typeof semanticAnalysis>;
