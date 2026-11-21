import { Express, RequestHandler } from "express";
import { apiError } from "./apiEnvelope.js";
import { logger } from "./logger.js";

interface TokenBucketOptions {
    capacity: number;
    refillPerSecond: number;
}

interface TokenBucket {
    tokens: number;
    updatedAt: number;
    lastSeenAt: number;
}

const bucketTtlMs = 15 * 60 * 1000;
const bucketCleanupIntervalMs = 60 * 1000;
const maxBuckets = 100_000;

/** Configures Express to honor forwarded addresses only from these CIDRs. */
export function configureTrustedProxies(app: Express) {
    const cidrs = (process.env.TRUSTED_PROXY_CIDRS ?? "")
        .split(/[\s,]+/)
        .map((cidr) => cidr.trim())
        .filter(Boolean);
    if (!cidrs.length) return;

    app.set("trust proxy", cidrs);
    logger.info("Trusted proxy CIDRs configured for client IP detection.", { cidrs });
}

/**
 * Creates an in-memory token bucket limiter keyed by the Express client IP.
 */
export function createTokenBucketRateLimiter(options: TokenBucketOptions): RequestHandler {
    const buckets = new Map<string, TokenBucket>();
    let lastCleanupAt = 0;

    return (req, res, next) => {
        const now = Date.now();
        if (now - lastCleanupAt >= bucketCleanupIntervalMs) {
            for (const [key, bucket] of buckets) {
                if (now - bucket.lastSeenAt >= bucketTtlMs) {
                    buckets.delete(key);
                }
            }
            lastCleanupAt = now;
        }

        const clientIp = req.ip || req.socket.remoteAddress || "unknown";
        let bucket = buckets.get(clientIp);
        if (!bucket) {
            if (buckets.size >= maxBuckets) {
                const oldestKey = buckets.keys().next().value;
                if (oldestKey) buckets.delete(oldestKey);
            }
            bucket = { tokens: options.capacity, updatedAt: now, lastSeenAt: now };
            buckets.set(clientIp, bucket);
        } else {
            const elapsedSeconds = Math.max(0, now - bucket.updatedAt) / 1000;
            bucket.tokens = Math.min(options.capacity, bucket.tokens + elapsedSeconds * options.refillPerSecond);
            bucket.updatedAt = now;
            bucket.lastSeenAt = now;
        }

        res.setHeader("RateLimit-Limit", String(options.capacity));
        res.setHeader("RateLimit-Remaining", String(Math.floor(bucket.tokens)));
        if (bucket.tokens < 1) {
            const retryAfterSeconds = Math.max(1, Math.ceil((1 - bucket.tokens) / options.refillPerSecond));
            res.setHeader("Retry-After", String(retryAfterSeconds));
            res.status(429).json(apiError("Too many requests. Please retry later.", 429, "rate_limited"));
            return;
        }

        bucket.tokens -= 1;
        res.setHeader("RateLimit-Remaining", String(Math.floor(bucket.tokens)));
        next();
    };
}

/** Creates shared API and stricter authentication token buckets from env. */
export function createApiRateLimiters() {
    return {
        api: createTokenBucketRateLimiter({
            capacity: readPositiveInteger("API_RATE_LIMIT_CAPACITY", 300),
            refillPerSecond: readPositiveNumber("API_RATE_LIMIT_REFILL_PER_SECOND", 5)
        }),
        login: createTokenBucketRateLimiter({
            capacity: readPositiveInteger("API_LOGIN_RATE_LIMIT_CAPACITY", 5),
            refillPerSecond: readPositiveNumber("API_LOGIN_RATE_LIMIT_REFILL_PER_SECOND", 1 / 60)
        })
    };
}

function readPositiveInteger(name: string, fallback: number) {
    const value = readPositiveNumber(name, fallback);
    if (!Number.isInteger(value)) {
        logger.warn("Rate limit setting must be a positive integer; using its default.", { setting: name, fallback });
        return fallback;
    }
    return value;
}

function readPositiveNumber(name: string, fallback: number) {
    const rawValue = process.env[name]?.trim();
    if (!rawValue) return fallback;
    const value = Number(rawValue);
    if (Number.isFinite(value) && value > 0) return value;
    logger.warn("Rate limit setting must be a positive number; using its default.", { setting: name, fallback });
    return fallback;
}
