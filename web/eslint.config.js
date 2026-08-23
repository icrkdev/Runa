// @ts-check
import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-properties": [
        "error",
        {
          object: "Math",
          property: "random",
          message: "RÚNA forbids Math.random for any security-relevant value; use crypto.getRandomValues.",
        },
      ],
      "no-restricted-globals": [
        "error",
        { name: "localStorage", message: "RÚNA never writes to localStorage (spec §11 standing rules)." },
        { name: "sessionStorage", message: "RÚNA never writes to sessionStorage (spec §11 standing rules)." },
        { name: "indexedDB", message: "RÚNA never writes to IndexedDB (spec §11 standing rules)." },
      ],
      "no-console": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
    },
  },
  {
    files: ["src/**/*.test.ts", "scripts/**"],
    rules: {
      "no-console": "off",
    },
  },
);
