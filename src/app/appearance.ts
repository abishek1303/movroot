import { z } from "zod";

export const accentNames = [
  "violet",
  "blue",
  "emerald",
  "orange",
  "pink",
  "cyan",
] as const;
const controls = {
  mode: z.enum(["system", "light", "dark"]),
  motion: z.enum(["system", "reduced"]),
};
export const appearanceSchema = z.strictObject({
  version: z.literal(2),
  ...controls,
  accent: z.enum(accentNames),
});
const legacySchema = z.strictObject({
  version: z.literal(1),
  ...controls,
  accent: z.enum(["lavender", "sage", "ocean", "amber", "rose", "graphite"]),
});
const migratedAccents = {
  lavender: "violet",
  sage: "emerald",
  ocean: "blue",
  amber: "orange",
  rose: "pink",
  graphite: "cyan",
} as const;

export type Appearance = z.infer<typeof appearanceSchema>;
export const defaults: Appearance = {
  version: 2,
  mode: "system",
  accent: "violet",
  motion: "system",
};
const key = "movroot.appearance";

export function loadAppearance(storage: Pick<Storage, "getItem">) {
  try {
    const record: unknown = JSON.parse(storage.getItem(key) ?? "null");
    const current = appearanceSchema.safeParse(record);
    if (current.success) return current.data;
    const legacy = legacySchema.safeParse(record);
    if (legacy.success)
      return {
        ...legacy.data,
        version: 2 as const,
        accent: migratedAccents[legacy.data.accent],
      };
    return defaults;
  } catch {
    return defaults;
  }
}

export function saveAppearance(
  storage: Pick<Storage, "setItem">,
  value: Appearance,
) {
  try {
    storage.setItem(key, JSON.stringify(appearanceSchema.parse(value)));
    return true;
  } catch {
    return false;
  }
}
