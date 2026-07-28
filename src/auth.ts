import { timingSafeEqual } from "node:crypto";
import { NextFunction, Request, Response } from "express";

/**
 * Handles optional admin-token protection for controller API routes.
 *
 * If no token is configured, the app remains open for local/trusted setups. If
 * a token exists, API and WebSocket callers must provide it as a bearer token.
 */
export class AdminAuth {
    private readonly adminToken = process.env.UPDATER_ADMIN_TOKEN || process.env.ADMIN_TOKEN || "";

    /**
     * Returns true when API callers must authenticate.
     */
    get required() {
        return Boolean(this.adminToken);
    }

    /**
     * Returns authentication metadata consumed by the Angular app.
     */
    status() {
        return {
            required: this.required
        };
    }

    /**
     * Validates a login attempt.
     */
    login(token?: string) {
        return !this.required || this.isValidToken(token);
    }

    /**
     * Express middleware that protects API routes when admin auth is enabled.
     */
    requireAuth = (req: Request, res: Response, next: NextFunction) => {
        if (!this.required) {
            next();
            return;
        }

        if (this.isValidToken(readBearerToken(req))) {
            next();
            return;
        }

        res.status(401).json({ error: "Admin token is required." });
    };

    /**
     * Compares a provided token with the configured admin token using constant
     * time comparison when both values are present.
     */
    isValidToken(token?: string) {
        if (!this.required) {
            return true;
        }

        if (!token) {
            return false;
        }

        const expected = Buffer.from(this.adminToken);
        const actual = Buffer.from(token);

        return expected.length === actual.length && timingSafeEqual(expected, actual);
    }
}

/**
 * Extracts a bearer token from the HTTP Authorization header.
 */
function readBearerToken(req: Request) {
    const header = req.headers.authorization ?? "";
    const value = Array.isArray(header) ? header[0] : header;
    const match = value.match(/^Bearer\s+(.+)$/i);
    return match?.[1]?.trim();
}
