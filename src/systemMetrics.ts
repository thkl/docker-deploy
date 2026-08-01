import { execFile } from "node:child_process";
import { cpus, freemem, loadavg, totalmem } from "node:os";
import { promisify } from "node:util";
import { ServerSystemMetrics } from "./types.js";

const execFileAsync = promisify(execFile);

/**
 * Reads host-level metrics from the agent/controller process environment.
 */
export async function collectSystemMetrics(): Promise<ServerSystemMetrics> {
    const totalMemoryBytes = totalmem();
    const freeMemoryBytes = freemem();
    return {
        checkedAt: new Date().toISOString(),
        loadAverage: loadavg(),
        cpuCount: cpus().length,
        memory: {
            totalBytes: totalMemoryBytes,
            freeBytes: freeMemoryBytes,
            usedBytes: Math.max(0, totalMemoryBytes - freeMemoryBytes)
        },
        disk: await readRootDiskUsage()
    };
}

async function readRootDiskUsage() {
    try {
        const { stdout } = await execFileAsync("df", ["-Pk", "/"]);
        const [, line] = stdout.trim().split(/\r?\n/);
        const parts = line?.trim().split(/\s+/) ?? [];
        const sizeKb = Number(parts[1]);
        const usedKb = Number(parts[2]);
        const availableKb = Number(parts[3]);
        if (!Number.isFinite(sizeKb) || !Number.isFinite(usedKb) || !Number.isFinite(availableKb)) {
            return undefined;
        }

        return {
            path: "/",
            totalBytes: sizeKb * 1024,
            usedBytes: usedKb * 1024,
            availableBytes: availableKb * 1024,
            usedPercent: sizeKb > 0 ? Math.round((usedKb / sizeKb) * 1000) / 10 : 0
        };
    } catch {
        return undefined;
    }
}
