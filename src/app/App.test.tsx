import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { App } from "./App";

test("identifies the application as Movroot", () => {
  expect(renderToStaticMarkup(<App />)).toContain("<h1>Movroot</h1>");
});
