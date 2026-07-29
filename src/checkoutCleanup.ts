import { isAbsolute, resolve } from "node:path";

export interface CheckoutCleanupResult {
    steps: string[];
}

type CheckoutDeleteWorker = (checkoutPath: string) => Promise<string>;

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
 * Removes a project checkout from the target server namespace.
 *
 * The controller can run in a container where `/root/docker-apps` is not the
 * same filesystem path as the Docker host, so cleanup must be delegated to an
 * agent/worker that has target-server path access.
 */
export async function removeCheckoutPath(checkoutPath: string, deleteWorker: CheckoutDeleteWorker): Promise<CheckoutCleanupResult> {
    const steps: string[] = [];
    logCleanupStep(steps, `requested checkout delete: ${checkoutPath}`);
    await runWorkerCleanup(checkoutPath, steps, deleteWorker, "delete target-server checkout path");

    return { steps };
}

/**
 * Runs the agent cleanup helper and records stdout/stderr for troubleshooting.
 */
async function runWorkerCleanup(checkoutPath: string, steps: string[], deleteWorker: CheckoutDeleteWorker, reason: string) {
    logCleanupStep(steps, `agent cleanup starting: ${reason}`);
    try {
        const output = await deleteWorker(checkoutPath);
        logCleanupStep(steps, output ? `agent cleanup completed: ${output}` : "agent cleanup completed with no output");
    } catch (error) {
        logCleanupStep(steps, `agent cleanup failed: ${readErrorMessage(error)}`);
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
