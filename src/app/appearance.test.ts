import { expect, test } from "vitest";
import { defaults, loadAppearance, saveAppearance } from "./appearance";

test("persists appearance, accent, and reduced motion independently", () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  };
  expect(loadAppearance(storage)).toEqual(defaults);
  const updated = {
    ...defaults,
    accent: "sage",
    mode: "dark",
    motion: "reduced",
  } as const;
  expect(saveAppearance(storage, updated)).toBe(true);
  expect(loadAppearance(storage)).toEqual(updated);
  expect(saveAppearance(storage, { ...updated, mode: "light" })).toBe(true);
  expect(loadAppearance(storage)).toEqual({ ...updated, mode: "light" });
});

test.each([
  "{",
  "null",
  '{"version":2}',
  '{"version":1,"mode":"dark","accent":"unknown","motion":"system"}',
])("falls back to defaults for corrupt or unsupported storage %s", (record) =>
  expect(loadAppearance({ getItem: () => record })).toEqual(defaults),
);

test("handles inaccessible storage", () => {
  const unavailable = () => {
    throw new Error("Storage unavailable");
  };
  expect(loadAppearance({ getItem: unavailable })).toEqual(defaults);
  expect(saveAppearance({ setItem: unavailable }, defaults)).toBe(false);
});
