import { NextFunction, Request, Response } from "express";

export interface ApiErrorEnvelope {
    error: {
        message: string;
        code: string;
        details?: unknown;
    };
}

export interface ApiSuccessEnvelope<T = unknown> {
    data: T;
}

/**
 * Normalizes controller API JSON responses without forcing each route handler
 * to repeat envelope code.
 */
export function apiEnvelopeMiddleware(req: Request, res: Response, next: NextFunction) {
    if (!req.path.startsWith("/api/")) {
        next();
        return;
    }

    const originalJson = res.json.bind(res);
    res.json = (body?: unknown) => {
        if (isApiEnvelope(body)) {
            return originalJson(body);
        }

        if (res.statusCode >= 400) {
            return originalJson(toErrorEnvelope(body, res.statusCode));
        }

        return originalJson({ data: body } satisfies ApiSuccessEnvelope);
    };

    next();
}

export function apiError(message: string, statusCode = 500, code?: string): ApiErrorEnvelope {
    return {
        error: {
            message,
            code: code || codeForStatus(statusCode)
        }
    };
}

function isApiEnvelope(body: unknown): body is ApiErrorEnvelope | ApiSuccessEnvelope {
    return isSuccessEnvelope(body) || isNestedApiError(body);
}

function toErrorEnvelope(body: unknown, statusCode: number): ApiErrorEnvelope {
    if (isNestedApiError(body)) {
        const error = body.error as { message?: unknown; code?: unknown; details?: unknown };
        return {
            error: {
                message: typeof error.message === "string" ? error.message : defaultMessage(statusCode),
                code: typeof error.code === "string" ? error.code : codeForStatus(statusCode),
                ...(error.details !== undefined ? { details: error.details } : {})
            }
        };
    }

    if (typeof body === "object" && body !== null && "error" in body) {
        const flat = body as { error?: unknown };
        const details = Object.fromEntries(Object.entries(body as Record<string, unknown>).filter(([key]) => key !== "error"));
        return {
            error: {
                message: typeof flat.error === "string" ? flat.error : defaultMessage(statusCode),
                code: codeForStatus(statusCode),
                ...(Object.keys(details).length ? { details } : {})
            }
        };
    }

    return {
        error: {
            message: typeof body === "string" ? body : defaultMessage(statusCode),
            code: codeForStatus(statusCode)
        }
    };
}

function isNestedApiError(body: unknown): body is ApiErrorEnvelope {
    return typeof body === "object"
        && body !== null
        && "error" in body
        && typeof (body as { error?: unknown }).error === "object"
        && (body as { error?: unknown }).error !== null
        && "message" in ((body as { error: object }).error);
}

function isSuccessEnvelope(body: unknown): body is ApiSuccessEnvelope {
    return typeof body === "object"
        && body !== null
        && "data" in body
        && Object.keys(body).length === 1;
}

function defaultMessage(statusCode: number) {
    return statusCode >= 500 ? "Internal server error." : "Request failed.";
}

function codeForStatus(statusCode: number) {
    switch (statusCode) {
        case 400:
            return "bad_request";
        case 401:
            return "unauthorized";
        case 403:
            return "forbidden";
        case 404:
            return "not_found";
        case 409:
            return "conflict";
        default:
            return statusCode >= 500 ? "internal_error" : "request_failed";
    }
}
