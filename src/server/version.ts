import fs from "node:fs";
import path from "node:path";

type PackageJson = {
  version?: string;
};

function readPackageVersion() {
  const packageJsonPath = path.resolve(process.cwd(), "package.json");
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as PackageJson;

  if (!packageJson.version) {
    throw new Error(`No version found in ${packageJsonPath}.`);
  }

  return packageJson.version;
}

export const APP_VERSION = readPackageVersion();
export const PLEX_USER_AGENT = `Hubarr/${APP_VERSION}`;

// BUILD_CHANNEL is baked into the Docker image at CI build time via --build-arg.
// Values: "stable" (release workflow), "develop" (develop workflow), "custom" (no arg passed — any non-CI build).
export const BUILD_CHANNEL = (process.env.BUILD_CHANNEL ?? "custom") as "stable" | "develop" | "custom";

// Full commit SHA baked in at build time. "local" when running outside CI.
const rawCommitSha = process.env.COMMIT_SHA ?? "local";
// Shorten to 7 chars for display, unless it's already "local".
export const BUILD_COMMIT = rawCommitSha === "local" ? "local" : rawCommitSha.slice(0, 7);
