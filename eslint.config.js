import js from "@eslint/js";
import playwright from "eslint-plugin-playwright";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "dist/",
      "node_modules/",
      "tests/playwright/.auth/",
      "tests/playwright-report/",
      "tests/test-results/"
    ]
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/client/**/*.{ts,tsx}"],
    languageOptions: {
      globals: {
        ...globals.browser,
        __APP_VERSION__: "readonly"
      }
    },
    plugins: {
      "react-hooks": reactHooks
    },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "error"
    }
  },
  {
    files: ["src/server/**/*.ts", "tests/server/**/*.ts", "*.config.{js,ts}"],
    languageOptions: {
      globals: globals.node
    }
  },
  {
    files: ["tests/playwright/**/*.ts"],
    ...playwright.configs["flat/recommended"],
    languageOptions: {
      ...playwright.configs["flat/recommended"].languageOptions,
      globals: {
        ...globals.node,
        ...playwright.configs["flat/recommended"].languageOptions.globals
      }
    },
    rules: {
      ...playwright.configs["flat/recommended"].rules,
      "playwright/expect-expect": "off",
      "playwright/no-conditional-expect": "off",
      "playwright/no-conditional-in-test": "off",
      "playwright/no-networkidle": "off",
      "playwright/no-skipped-test": "off",
      "playwright/no-useless-not": "off"
    }
  }
);
