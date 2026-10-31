import { ProjectInfisicalSettings } from "./types.js";

const infisicalRequestTimeoutMs = 15_000;

/** Fetches only the explicitly mapped project secrets from Infisical. */
export async function fetchInfisicalSecrets(settings: ProjectInfisicalSettings, secretNames: string[]) {
    const names = [...new Set(secretNames.map((name) => name.trim()).filter(Boolean))];
    if (!settings.enabled) throw new Error("Infisical secret bindings are configured, but the Infisical integration is disabled.");

    const siteUrl = normalizeInfisicalSiteUrl(settings.siteUrl);
    const clientId = settings.clientId.trim();
    const clientSecret = settings.clientSecret?.trim() ?? "";
    const projectId = settings.projectId.trim();
    const environment = settings.environment.trim();
    const secretPath = settings.secretPath.trim() || "/";
    if (!clientId || !clientSecret || !projectId || !environment) {
        throw new Error("Infisical is enabled, but the instance URL, client ID, client secret, project ID, or environment is missing.");
    }

    const loginResponse = await fetchWithTimeout(`${siteUrl}/api/v1/auth/universal-auth/login`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ clientId, clientSecret })
    });
    if (!loginResponse.ok) {
        throw new Error(`Infisical authentication failed (HTTP ${loginResponse.status}). Check the machine identity credentials and instance URL.`);
    }
    const loginBody = await readJson(loginResponse, "Infisical returned an invalid authentication response.");
    const accessToken = readString(loginBody.accessToken);
    if (!accessToken) throw new Error("Infisical authentication succeeded without returning an access token.");
    if (!names.length) return new Map<string, string>();

    const values = await Promise.all(names.map(async (secretName) => {
        if (!/^[A-Za-z0-9_.-]+$/.test(secretName)) {
            throw new Error(`Infisical secret name '${secretName}' contains unsupported characters.`);
        }
        const url = new URL(`${siteUrl}/api/v4/secrets/${encodeURIComponent(secretName)}`);
        url.searchParams.set("projectId", projectId);
        url.searchParams.set("environment", environment);
        url.searchParams.set("secretPath", secretPath);
        const response = await fetchWithTimeout(url, {
            headers: { authorization: `Bearer ${accessToken}` }
        });
        if (!response.ok) {
            throw new Error(`Could not fetch Infisical secret '${secretName}' (HTTP ${response.status}). Check its project, environment, path, and identity access.`);
        }

        const body = await readJson(response, `Infisical returned an invalid response for secret '${secretName}'.`);
        const secret = asRecord(body.secret) ?? asRecord(asRecord(body.data)?.secret) ?? asRecord(body.data) ?? body;
        const value = readString(secret.secretValue);
        if (value === undefined) throw new Error(`Infisical did not return a value for secret '${secretName}'.`);
        return [secretName, value] as const;
    }));

    return new Map(values);
}

function normalizeInfisicalSiteUrl(value: string) {
    let url: URL;
    try {
        url = new URL(value.trim());
    } catch {
        throw new Error("Enter a valid Infisical instance URL, including https://.");
    }
    const isLoopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1";
    if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback)) {
        throw new Error("The Infisical instance URL must use HTTPS. HTTP is allowed only for localhost.");
    }
    if (url.username || url.password || url.search || url.hash) {
        throw new Error("The Infisical instance URL cannot contain credentials, query parameters, or a fragment.");
    }
    return url.toString().replace(/\/+$/, "");
}

async function fetchWithTimeout(input: string | URL, init: RequestInit) {
    try {
        return await fetch(input, { ...init, redirect: "error", signal: AbortSignal.timeout(infisicalRequestTimeoutMs) });
    } catch (error) {
        if (error instanceof Error && error.name === "TimeoutError") {
            throw new Error("Timed out while connecting to Infisical.");
        }
        throw new Error("Could not connect to the configured Infisical instance.");
    }
}

async function readJson(response: Response, errorMessage: string): Promise<Record<string, unknown>> {
    try {
        const body: unknown = await response.json();
        return asRecord(body) ?? {};
    } catch {
        throw new Error(errorMessage);
    }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function readString(value: unknown) {
    return typeof value === "string" ? value : undefined;
}
