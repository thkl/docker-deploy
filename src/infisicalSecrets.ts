import { ProjectInfisicalSettings } from "./types.js";
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";
import { SpiffeX509Identity, fetchSpiffeX509Identity } from "./spiffeWorkloadApi.js";

const infisicalRequestTimeoutMs = 15_000;

export interface InfisicalSecretReference {
    name: string;
    path?: string;
}

export interface InfisicalSecretNameBinding {
    name: string;
    path: string;
}

/** Lists secret keys in the requested paths without requesting their values. */
export async function listInfisicalSecretNames(settings: ProjectInfisicalSettings, secretPaths: string[]): Promise<InfisicalSecretNameBinding[]> {
    const auth = await authenticateInfisical(settings);
    const paths = [...new Set(secretPaths.map(normalizeInfisicalSecretPath))];
    const pathBindings = await Promise.all(paths.map(async (path) => {
        const url = new URL(`${auth.siteUrl}/api/v4/secrets`);
        url.searchParams.set("projectId", auth.projectId);
        url.searchParams.set("environment", auth.environment);
        url.searchParams.set("secretPath", path);
        url.searchParams.set("viewSecretValue", "false");

        const response = await fetchWithTimeout(url, {
            headers: credentialHeaders(auth)
        }, auth.tlsIdentity);
        if (!response.ok) {
            const detail = await readErrorMessage(response);
            throw new Error(`Could not list secrets from '${path}' (HTTP ${response.status})${detail ? `: ${detail}` : ". Check the project, environment, path, and workload identity access."}`);
        }

        const body = await readJson(response, `The credential system returned an invalid secret list for '${path}'.`);
        const secrets = Array.isArray(body.secrets) ? body.secrets : [];
        const secretNames = [...new Set(secrets.flatMap((entry) => {
            const secret = asRecord(entry);
            const name = readString(secret?.secretKey)?.trim();
            return name ? [name] : [];
        }))].sort((left, right) => left.localeCompare(right));
        return secretNames.map((name) => ({ name, path }));
    }));
    return pathBindings.flat();
}

/** Fetches only the explicitly mapped project secrets from the configured credential system. */
export async function fetchInfisicalSecrets(settings: ProjectInfisicalSettings, secretReferences: Array<string | InfisicalSecretReference>) {
    const defaultPath = normalizeInfisicalSecretPath(settings.secretPath);
    const references = secretReferences
        .map((reference) => normalizeInfisicalSecretReference(reference, defaultPath))
        .filter((reference) => reference.name);
    const uniqueReferences = [...new Map(references.map((reference) => [infisicalSecretReferenceKey(reference.name, reference.path), reference])).values()];
    const auth = await authenticateInfisical(settings);
    if (!uniqueReferences.length) return new Map<string, string>();

    const values = await Promise.all(uniqueReferences.map(async (reference) => {
        if (!/^[A-Za-z0-9_.-]+$/.test(reference.name)) {
            throw new Error(`Secret name '${reference.name}' contains unsupported characters.`);
        }
        const url = new URL(`${auth.siteUrl}/api/v4/secrets/${encodeURIComponent(reference.name)}`);
        url.searchParams.set("projectId", auth.projectId);
        url.searchParams.set("environment", auth.environment);
        url.searchParams.set("secretPath", reference.path);
        const response = await fetchWithTimeout(url, {
            headers: credentialHeaders(auth)
        }, auth.tlsIdentity);
        if (!response.ok) {
            throw new Error(`Could not fetch secret '${reference.name}' from '${reference.path}' (HTTP ${response.status}). Check the project, environment, path, and workload identity access.`);
        }

        const body = await readJson(response, `The credential system returned an invalid response for secret '${reference.name}'.`);
        const secret = asRecord(body.secret) ?? asRecord(asRecord(body.data)?.secret) ?? asRecord(body.data) ?? body;
        const value = readString(secret.secretValue);
        if (value === undefined) throw new Error(`The credential system did not return a value for secret '${reference.name}'.`);
        return [infisicalSecretReferenceKey(reference.name, reference.path), value] as const;
    }));

    return new Map(values);
}

async function authenticateInfisical(settings: ProjectInfisicalSettings) {
    if (!settings.enabled) throw new Error("The credential system is disabled for this project.");

    const siteUrl = normalizeInfisicalSiteUrl(settings.siteUrl);
    const projectId = settings.projectId.trim();
    const environment = settings.environment.trim();
    if (!projectId || !environment) {
        throw new Error("The credential system project ID or environment is missing.");
    }

    if (settings.authMethod === "spiffe-x509") {
        if (!siteUrl.startsWith("https://")) {
            throw new Error("SPIFFE certificate authentication requires an HTTPS credential system URL.");
        }
        const tlsIdentity = await fetchSpiffeX509Identity(settings.spiffeId ?? "");
        return { siteUrl, projectId, environment, tlsIdentity };
    }

    const clientId = settings.clientId.trim();
    const clientSecret = settings.clientSecret?.trim() ?? "";
    if (!clientId || !clientSecret) {
        throw new Error("Client ID and client secret authentication is selected, but its credentials are incomplete.");
    }

    const loginResponse = await fetchWithTimeout(`${siteUrl}/api/v1/auth/universal-auth/login`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ clientId, clientSecret })
    });
    if (!loginResponse.ok) {
        throw new Error(`Credential system login failed (HTTP ${loginResponse.status}). Check the machine identity credentials and URL.`);
    }
    const loginBody = await readJson(loginResponse, "The credential system returned an invalid login response.");
    const accessToken = readString(loginBody.accessToken);
    if (!accessToken) throw new Error("Credential system login succeeded without returning an access token.");
    return { siteUrl, projectId, environment, accessToken };
}

function credentialHeaders(auth: { accessToken?: string }): Record<string, string> {
    return auth.accessToken ? { authorization: `Bearer ${auth.accessToken}` } : {};
}

export function normalizeInfisicalSecretReference(reference: string | InfisicalSecretReference, defaultPath: string) {
    const suppliedName = typeof reference === "string" ? reference.trim() : reference.name.trim();
    let name = suppliedName;
    let path = normalizeInfisicalSecretPath(typeof reference === "string" ? defaultPath : reference.path || defaultPath);

    if (suppliedName.startsWith("/")) {
        const segments = suppliedName.split("/").filter(Boolean);
        name = segments.pop() ?? "";
        path = segments.length ? normalizeInfisicalSecretPath(`/${segments.join("/")}`) : "/";
    }

    return { name, path };
}

export function normalizeInfisicalSecretPath(value: string | undefined) {
    const segments = String(value ?? "").trim().split("/").map((segment) => segment.trim()).filter(Boolean);
    return segments.length ? `/${segments.join("/")}` : "/";
}

export function infisicalSecretReferenceKey(name: string, path: string | undefined) {
    const reference = normalizeInfisicalSecretReference({ name, path }, "/");
    return JSON.stringify([reference.path, reference.name]);
}

function normalizeInfisicalSiteUrl(value: string) {
    let url: URL;
    try {
        url = new URL(value.trim());
    } catch {
        throw new Error("Enter a valid credential system URL, including https://.");
    }
    const isLoopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1";
    if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback)) {
        throw new Error("The credential system URL must use HTTPS. HTTP is allowed only for localhost with client ID/secret authentication.");
    }
    if (url.username || url.password || url.search || url.hash) {
        throw new Error("The credential system URL cannot contain credentials, query parameters, or a fragment.");
    }
    return url.toString().replace(/\/+$/, "");
}

async function fetchWithTimeout(input: string | URL, init: RequestInit, tlsIdentity?: SpiffeX509Identity): Promise<Response> {
    if (tlsIdentity) return fetchWithClientCertificate(input, init, tlsIdentity);
    try {
        return await fetch(input, { ...init, redirect: "error", signal: AbortSignal.timeout(infisicalRequestTimeoutMs) });
    } catch (error) {
        if (error instanceof Error && error.name === "TimeoutError") {
            throw new Error("Timed out while connecting to the credential system.");
        }
        throw new Error("Could not connect to the configured credential system.");
    }
}

function fetchWithClientCertificate(input: string | URL, init: RequestInit, identity: SpiffeX509Identity): Promise<Response> {
    const url = input instanceof URL ? input : new URL(input);
    if (url.protocol !== "https:") throw new Error("SPIFFE certificate authentication requires HTTPS.");

    const agent = new HttpsAgent({
        cert: identity.certificate,
        key: identity.privateKey,
        rejectUnauthorized: true,
        keepAlive: false
    });
    const headers = new Headers(init.headers);
    const requestHeaders: Record<string, string> = {};
    headers.forEach((value, key) => { requestHeaders[key] = value; });
    requestHeaders["accept-encoding"] ??= "identity";
    const body = requestBodyBuffer(init.body);

    return new Promise((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => request.destroy(new Error("TimeoutError")), infisicalRequestTimeoutMs);
        timer.unref();
        const finishError = (error: unknown) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            agent.destroy();
            const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.message === "TimeoutError");
            reject(new Error(timedOut ? "Timed out while connecting to the credential system over mTLS." : "Could not connect to the credential system using its configured SPIFFE identity."));
        };

        const request = httpsRequest(url, {
            method: init.method ?? "GET",
            headers: requestHeaders,
            agent
        }, (response) => {
            const chunks: Buffer[] = [];
            response.on("data", (chunk: Buffer | string) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
            response.on("error", finishError);
            response.on("end", () => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                agent.destroy();
                const status = response.statusCode ?? 500;
                if (status >= 300 && status < 400) {
                    reject(new Error("The credential system redirected an mTLS request. Configure its final HTTPS URL directly."));
                    return;
                }
                const responseHeaders = new Headers();
                for (const [name, value] of Object.entries(response.headers)) {
                    if (Array.isArray(value)) value.forEach((item) => responseHeaders.append(name, item));
                    else if (typeof value === "string") responseHeaders.set(name, value);
                }
                const responseBody = [204, 205, 304].includes(status) ? null : Buffer.concat(chunks);
                resolve(new Response(responseBody, {
                    status,
                    statusText: response.statusMessage,
                    headers: responseHeaders
                }));
            });
        });
        request.on("error", finishError);
        if (body) request.write(body);
        request.end();
    });
}

function requestBodyBuffer(body: BodyInit | null | undefined) {
    if (body === null || body === undefined) return undefined;
    if (typeof body === "string") return Buffer.from(body);
    if (body instanceof URLSearchParams) return Buffer.from(body.toString());
    if (body instanceof ArrayBuffer) return Buffer.from(body);
    if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
    throw new Error("The mTLS request body type is not supported.");
}

async function readJson(response: Response, errorMessage: string): Promise<Record<string, unknown>> {
    try {
        const body: unknown = await response.json();
        return asRecord(body) ?? {};
    } catch {
        throw new Error(errorMessage);
    }
}

async function readErrorMessage(response: Response) {
    try {
        const body = asRecord(await response.json());
        const message = readString(body?.message) ?? readString(body?.error);
        return message?.replace(/\s+/g, " ").trim().slice(0, 240) ?? "";
    } catch {
        return "";
    }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function readString(value: unknown) {
    return typeof value === "string" ? value : undefined;
}
