import { readFileSync } from "node:fs";
import { join } from "node:path";

let cachedVersion = "";

/**
 * Reads the package version for controller and agent health responses.
 */
export function appVersion() {
    if (cachedVersion) {
        return cachedVersion;
    }

    try {
        const packageJson = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as { version?: string };
        cachedVersion = packageJson.version || "unknown";
    } catch {
        cachedVersion = process.env.npm_package_version || "unknown";
    }

    return cachedVersion;
}
