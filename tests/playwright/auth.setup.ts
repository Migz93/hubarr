import { test as setup, expect } from "@playwright/test";
import fs from "fs";
import path from "path";

const authFile = "tests/playwright/.auth/storageState.json";

setup("authenticate", async ({ page, context }) => {
  // If we already have a saved session, check it's still valid
  if (fs.existsSync(authFile)) {
    await page.goto("/api/auth/session");
    const body = await page.evaluate(() => document.body.innerText);
    const session = JSON.parse(body) as { authenticated: boolean };
    if (session.authenticated) {
      console.log("  Existing session is still valid, skipping login.");
      return;
    }
    console.log("  Saved session has expired, re-authenticating...");
  }

  // No valid session — open the login page and wait for you to complete Plex OAuth
  console.log("\n  ┌─────────────────────────────────────────────────────────────────┐");
  console.log("  │  ACTION REQUIRED: A browser window will open.                  │");
  console.log("  │  Log in with Plex, then come back here — tests will continue.  │");
  console.log("  └─────────────────────────────────────────────────────────────────┘\n");

  await page.goto("/login");

  // Wait for Plex OAuth to complete and the app to land on /dashboard
  // Timeout is 3 minutes to give you time to log in
  await page.waitForURL("**/dashboard", { timeout: 180_000 });
  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();

  // Save the session so future runs skip login
  fs.mkdirSync(path.dirname(authFile), { recursive: true });
  await context.storageState({ path: authFile });
  console.log("  Session saved to", authFile);
});
