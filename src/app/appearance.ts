import { z } from "zod";

export const appearanceSchema = z.strictObject({
  version: z.literal(1),
  mode: z.enum(["system", "light", "dark"]),
  accent: z.enum(["lavender", "sage", "ocean", "amber", "rose", "graphite"]),
  motion: z.enum(["system", "reduced"]),
});
export type Appearance = z.infer<typeof appearanceSchema>;
export const defaults: Appearance = {
  version: 1,
  mode: "system",
  accent: "lavender",
  motion: "system",
};
const key = "movroot.appearance";

export function loadAppearance(storage: Pick<Storage, "getItem">) {
  try {
    return appearanceSchema.parse(JSON.parse(storage.getItem(key) ?? "null"));
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
