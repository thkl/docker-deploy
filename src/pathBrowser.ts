import { execFile } from "node:child_process";
import { accessSync, constants, readdirSync, statSync } from "node:fs";
import { dirname, posix } from "node:path";
import { promisify } from "node:util";
import { PathBrowseResult } from "./types.js";

const execFileAsync = promisify(execFile);
const dockerBrowserImage = "node:24.16.0-alpine";

export function browseContainerPath(inputPath: string): PathBrowseResult {
    const path = normalizeBrowsePath(inputPath);
    const entries = readdirSync(path, { withFileTypes: true })
        .filter((entry) => !entry.name.startsWith("."))
        .map((entry) => {
            const fullPath = posix.join(path, entry.name);
            const stats = statSync(fullPath);
            return {
                name: entry.name,
                path: fullPath,
                type: entry.isDirectory() ? "directory" as const : "file" as const,
                writable: entry.isDirectory() ? canWrite(fullPath) : false,
                size: entry.isFile() ? stats.size : undefined
            };
        })
        .sort((left, right) => left.type === right.type ? left.name.localeCompare(right.name) : left.type === "directory" ? -1 : 1);

    return {
        path,
        parent: path === "/" ? "" : dirname(path),
        entries
    };
}

export async function browseDockerHostPath(inputPath: string): Promise<PathBrowseResult> {
    const path = normalizeBrowsePath(inputPath);
    const script = `
const fs = require("node:fs");
const pathModule = require("node:path");
const requested = process.argv[1];
const hostPath = pathModule.posix.join("/host", requested);
const entries = fs.readdirSync(hostPath, { withFileTypes: true })
  .filter((entry) => !entry.name.startsWith("."))
  .map((entry) => {
    const fullPath = pathModule.posix.join(requested, entry.name);
    const mountedPath = pathModule.posix.join(hostPath, entry.name);
    const stats = fs.statSync(mountedPath);
    let writable = false;
    if (entry.isDirectory()) {
      try { fs.accessSync(mountedPath, fs.constants.W_OK); writable = true; } catch {}
    }
    return {
      name: entry.name,
      path: fullPath,
      type: entry.isDirectory() ? "directory" : "file",
      writable,
      size: entry.isFile() ? stats.size : undefined
    };
  })
  .sort((left, right) => left.type === right.type ? left.name.localeCompare(right.name) : left.type === "directory" ? -1 : 1);
process.stdout.write(JSON.stringify({
  path: requested,
  parent: requested === "/" ? "" : pathModule.posix.dirname(requested),
  entries
}));
`;
    const { stdout } = await execFileAsync("docker", ["run", "--rm", "-v", "/:/host:ro", dockerBrowserImage, "node", "-e", script, path], { maxBuffer: 1024 * 1024 });
    return JSON.parse(stdout) as PathBrowseResult;
}

function normalizeBrowsePath(value: string) {
    const path = value.trim() || "/";
    if (!path.startsWith("/")) {
        throw new Error("Path must be absolute.");
    }
    return path.replace(/\/+$/, "") || "/";
}

function canWrite(path: string) {
    try {
        accessSync(path, constants.W_OK);
        return true;
    } catch {
        return false;
    }
}
