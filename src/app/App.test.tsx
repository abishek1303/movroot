import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { App } from "./App";

test("starts at folder selection with History available and diagnostics closed", () => {
  const markup = renderToStaticMarkup(<App />);
  expect(markup).toContain("Movroot</h1>");
  expect(markup).toContain("Choose folder");
  expect(markup).toContain('aria-current="step"');
  expect(markup).toContain("No operations yet");
  expect(markup).not.toContain("Discovered files and thumbnails");
  expect(markup).not.toContain("Muse Ember diagnostics");
});
