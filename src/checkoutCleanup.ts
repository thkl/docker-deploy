import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { deleteCheckoutPath } from "./deploy.js";

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
export async function removeCheckoutPath(checkoutPath: string) {
    try {
        await rm(checkoutPath, { recursive: true, force: true });
    } catch (error) {
        await deleteCheckoutPath(checkoutPath);
    }

    if (existsSync(checkoutPath)) {
        await deleteCheckoutPath(checkoutPath);
    }

    if (existsSync(checkoutPath)) {
        throw new Error(`Checkout path still exists after deletion attempt: ${checkoutPath}`);
    }
}
