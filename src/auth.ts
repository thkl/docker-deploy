import { timingSafeEqual } from "node:crypto";
import { NextFunction, Request, Response } from "express";

export class AdminAuth {
    private readonly adminToken = process.env.UPDATER_ADMIN_TOKEN || process.env.ADMIN_TOKEN || "";

    get required() {
        return Boolean(this.adminToken);
    }

    status() {
        return {
            required: this.required
        };
    }

    login(token?: string) {
        return !this.required || this.isValidToken(token);
    }

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

function readBearerToken(req: Request) {
    const header = req.headers.authorization ?? "";
    const value = Array.isArray(header) ? header[0] : header;
    const match = value.match(/^Bearer\s+(.+)$/i);
    return match?.[1]?.trim();
}
