import { hostname } from "node:os";
import { inspect } from "node:util";
import winston from "winston";

const levels = new Set(["error", "warn", "info", "http", "verbose", "debug", "silly"]);
const configuredLevel = process.env.DEPLOY_LOG_LEVEL?.trim().toLowerCase() || "info";
const logLevel = levels.has(configuredLevel) ? configuredLevel : "info";

if (!levels.has(configuredLevel)) {
    process.stderr.write(`[logging] Unknown DEPLOY_LOG_LEVEL '${configuredLevel}', using 'info'.\n`);
}

const transports: winston.transport[] = [
    new winston.transports.Console({
        stderrLevels: ["error", "warn"],
        format: winston.format.printf((info) => {
            const { timestamp, level, message, stack, service: _service, role: _role, hostname: _hostname, ...metadata } = info;
            const renderedMessage = typeof stack === "string" ? stack : renderValue(message);
            const remainingMetadata = Object.keys(metadata).length ? ` ${inspect(metadata, { colors: false, compact: true, depth: 5 })}` : "";
            return `${timestamp} ${level}: ${renderedMessage}${remainingMetadata}`;
        })
    })
];

const httpTransport = createHttpTransport();
if (httpTransport) {
    let lastWarningAt = 0;
    httpTransport.on("warn", (error: Error) => {
        const now = Date.now();
        if (now - lastWarningAt < 60_000) return;
        lastWarningAt = now;
        process.stderr.write(`[logging:http] Delivery failed: ${error.message}\n`);
    });
    transports.push(httpTransport);
}

export const logger = winston.createLogger({
    level: logLevel,
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.errors({ stack: true }),
        winston.format.splat()
    ),
    defaultMeta: {
        service: "docker-deploy",
        role: process.env.DEPLOY_ROLE?.trim() || process.env.UPDATER_ROLE?.trim() || "standalone",
        hostname: hostname()
    },
    transports
});

function createHttpTransport(): winston.transports.HttpTransportInstance | undefined {
    const endpoint = process.env.DEPLOY_LOG_HTTP_URL?.trim();
    if (!endpoint) return undefined;

    try {
        const url = new URL(endpoint);
        if (url.protocol !== "http:" && url.protocol !== "https:") {
            throw new Error("URL must use http:// or https://.");
        }

        const headers = parseHttpHeaders(process.env.DEPLOY_LOG_HTTP_HEADERS);
        const bearer = process.env.DEPLOY_LOG_HTTP_BEARER_TOKEN?.trim();
        const username = process.env.DEPLOY_LOG_HTTP_USERNAME?.trim() || decodeURIComponent(url.username);
        const password = process.env.DEPLOY_LOG_HTTP_PASSWORD ?? decodeURIComponent(url.password);
        const auth = bearer
            ? { bearer }
            : username || password
                ? { username, password }
                : undefined;

        return new winston.transports.Http({
            host: url.hostname,
            port: Number(url.port) || (url.protocol === "https:" ? 443 : 80),
            path: `${url.pathname}${url.search}` || "/",
            ssl: url.protocol === "https:",
            level: configuredHttpLevel(),
            headers,
            ...(auth ? { auth } : {})
        });
    } catch (error) {
        process.stderr.write(`[logging] HTTP transport disabled: ${error instanceof Error ? error.message : String(error)}\n`);
        return undefined;
    }
}

function configuredHttpLevel() {
    const value = process.env.DEPLOY_LOG_HTTP_LEVEL?.trim().toLowerCase() || "info";
    if (levels.has(value)) return value;
    process.stderr.write(`[logging] Unknown DEPLOY_LOG_HTTP_LEVEL '${value}', using 'info'.\n`);
    return "info";
}

function parseHttpHeaders(value: string | undefined): Record<string, string> {
    if (!value?.trim()) return {};
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("DEPLOY_LOG_HTTP_HEADERS must be a JSON object of string values.");
    }
    const entries = Object.entries(parsed as Record<string, unknown>);
    if (entries.some(([, headerValue]) => typeof headerValue !== "string")) {
        throw new Error("DEPLOY_LOG_HTTP_HEADERS must contain only string values.");
    }
    return Object.fromEntries(entries) as Record<string, string>;
}

function renderValue(value: unknown) {
    return typeof value === "string" ? value : inspect(value, { colors: false, compact: true, depth: 5 });
}
