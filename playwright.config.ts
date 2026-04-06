import { defineConfig, devices } from "@playwright/test";
import { config } from "dotenv";

config({ path: ".env.playwright" });

const baseURL = process.env.BASE_URL ?? "http://localhost:3000";

export default defineConfig({
  testDir: "./tests/playwright",
  fullyParallel: false,
  retries: 0,
  reporter: "list",

  use: {
    baseURL,
    storageState: "tests/playwright/.auth/storageState.json",
    trace: "on-first-retry"
  },

  projects: [
    // Auth setup runs first — opens a browser for you to log in manually
    {
      name: "auth-setup",
      testMatch: /auth\.setup\.ts/
    },
    // All other tests depend on auth being done
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
      dependencies: ["auth-setup"]
    }
  ]
});
