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
