import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { deleteCheckoutPath } from "./deploy.js";

export interface CheckoutCleanupResult {
    steps: string[];
}

/**
 * Validates that a configured checkout path is safe to delete automatically.
 *
 * The guard allows custom absolute checkout paths but refuses root, the data
 * root itself, and very shallow paths that are too risky for recursive removal.
 */
export function assertSafeDeletePath(path: string, dataRoot: string) {
    if (!isAbsolute(path)) {
        throw new Error("Checkout path must be absolute before it can be deleted.");
    }

    const resolvedPath = resolve(path);
    const resolvedDataRoot = resolve(dataRoot);
    const pathParts = resolvedPath.split("/").filter(Boolean);

    if (
        resolvedPath === "/" ||
        resolvedPath === resolvedDataRoot ||
        pathParts.length < 3
    ) {
        throw new Error(`Refusing to delete unsafe checkout path: ${resolvedPath}`);
    }

    return resolvedPath;
}

/**
 * Removes a project checkout and verifies the path is gone.
 *
 * The local removal is fast when permissions allow it. The Docker fallback
 * handles root-owned files created by deployment worker containers.
 */
export async function removeCheckoutPath(checkoutPath: string): Promise<CheckoutCleanupResult> {
    const steps: string[] = [];
    logCleanupStep(steps, `requested checkout delete: ${checkoutPath}`);
    logCleanupStep(steps, `exists before delete: ${existsSync(checkoutPath)}`);

    try {
        await rm(checkoutPath, { recursive: true, force: true });
        logCleanupStep(steps, "local rm completed");
    } catch (error) {
        logCleanupStep(steps, `local rm failed: ${readErrorMessage(error)}`);
        await runDockerCleanup(checkoutPath, steps, "local rm failure");
    }

    if (existsSync(checkoutPath)) {
        logCleanupStep(steps, "path still exists after local rm; running Docker cleanup fallback");
        await runDockerCleanup(checkoutPath, steps, "path still exists after local rm");
    }

    if (existsSync(checkoutPath)) {
        logCleanupStep(steps, "path still exists after Docker cleanup");
        throw new Error(`Checkout path still exists after deletion attempt: ${checkoutPath}`);
    }

    logCleanupStep(steps, "checkout path removed");
    return { steps };
}

/**
 * Runs the Docker cleanup helper and records stdout/stderr for troubleshooting.
 */
async function runDockerCleanup(checkoutPath: string, steps: string[], reason: string) {
    logCleanupStep(steps, `docker cleanup starting: ${reason}`);
    try {
        const output = await deleteCheckoutPath(checkoutPath);
        logCleanupStep(steps, output ? `docker cleanup completed: ${output}` : "docker cleanup completed with no output");
    } catch (error) {
        logCleanupStep(steps, `docker cleanup failed: ${readErrorMessage(error)}`);
        throw error;
    }
}

/**
 * Records one cleanup step in both the API debug trail and server logs.
 */
function logCleanupStep(steps: string[], message: string) {
    const line = `[checkout-cleanup] ${message}`;
    steps.push(line);
    console.log(line);
}

/**
 * Extracts a readable message from unknown caught errors.
 */
function readErrorMessage(error: unknown) {
    return error instanceof Error ? error.message : String(error);
}
