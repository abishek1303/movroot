import { builtinModules } from "node:module";
import js from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

const nativeImports = {
  group: ["@tauri-apps/**"],
  message: "Use an infrastructure adapter.",
};
const infrastructure = {
  regex: "^(?:\\.{1,2}/|@/)(?:[^/]+/)*infrastructure(?:/|$)",
  message: "Use a consumer-owned interface and wire the adapter in src/app.",
};

export default [
  { ignores: ["dist/**", "src-tauri/**", ".movroot-local/**", "coverage/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  { ...reactHooks.configs.flat.recommended, files: ["src/**/*.tsx"] },
  {
    files: [
      "src/core/**/*.{ts,tsx}",
      "src/features/*/application/**/*.{ts,tsx}",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            ...new Set(
              builtinModules.filter((name) => !name.startsWith("node:")),
            ),
          ],
          patterns: [
            nativeImports,
            infrastructure,
            {
              group: [
                "node:*",
                "react",
                "react/**",
                "react-dom",
                "react-dom/**",
              ],
              message: "Keep application and domain code portable.",
            },
            {
              regex: "^(?:\\.{1,2}/|@/)(?:[^/]+/)*(?:app|components|ui)(?:/|$)",
              message:
                "Keep presentation and composition outside portable modules.",
            },
          ],
        },
      ],
      "no-restricted-globals": [
        "error",
        "process",
        "Buffer",
        "require",
        "window",
        "document",
        "localStorage",
      ],
    },
  },
  {
    files: ["src/components/**/*.{ts,tsx}", "src/features/*/ui/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        { patterns: [nativeImports, infrastructure] },
      ],
    },
  },
];
