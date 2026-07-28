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
 * Removes a project checkout from both the controller namespace and the Docker
 * host namespace.
 *
 * The controller can run in a container where `/root/docker-apps` is not the
 * same filesystem path as the Docker host. Because deployments clone through
 * the host Docker daemon, Docker cleanup must always run even when local `rm`
 * appears to succeed.
 */
export async function removeCheckoutPath(checkoutPath: string): Promise<CheckoutCleanupResult> {
    const steps: string[] = [];
    logCleanupStep(steps, `requested checkout delete: ${checkoutPath}`);
    logCleanupStep(steps, `controller namespace exists before delete: ${existsSync(checkoutPath)}`);

    try {
        await rm(checkoutPath, { recursive: true, force: true });
        logCleanupStep(steps, "controller namespace rm completed");
    } catch (error) {
        logCleanupStep(steps, `controller namespace rm failed: ${readErrorMessage(error)}`);
    }

    await runDockerCleanup(checkoutPath, steps, "delete Docker host checkout path");

    if (existsSync(checkoutPath)) {
        logCleanupStep(steps, "controller namespace path still exists after cleanup");
    } else {
        logCleanupStep(steps, "controller namespace path removed");
    }

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
