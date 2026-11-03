import { createHash, createHmac, timingSafeEqual } from "node:crypto";

const maxInfisicalWebhookAgeSeconds = 300;

export interface InfisicalWebhookSignatureDiagnostics {
    reason: string;
    rawBodyBytes: number;
    rawBodySha256: string | null;
    headerLength: number;
    timestamp: string | null;
    timestampUnit: "seconds" | "milliseconds" | null;
    timestampAgeSeconds: number | null;
    signaturePresent: boolean;
    signaturePrefix: string | null;
    signatureLength: number;
    signatureEncoding: "hex" | "base64" | "unknown" | null;
    checkedFormats: string[];
    matchedFormat: string | null;
}

/** Verify Infisical's signed project webhook using the exact captured body. */
export function verifyInfisicalWebhookSignature(secret: string, header: string, rawBody: Buffer | undefined) {
    return inspectInfisicalWebhookSignature(secret, header, rawBody).valid;
}

export function inspectInfisicalWebhookSignature(secret: string, header: string, rawBody: Buffer | undefined) {
    const diagnostics: InfisicalWebhookSignatureDiagnostics = {
        reason: "not_checked",
        rawBodyBytes: rawBody?.length ?? 0,
        rawBodySha256: rawBody?.length ? createHash("sha256").update(rawBody).digest("hex") : null,
        headerLength: header.length,
        timestamp: null,
        timestampUnit: null,
        timestampAgeSeconds: null,
        signaturePresent: false,
        signaturePrefix: null,
        signatureLength: 0,
        signatureEncoding: null,
        checkedFormats: [],
        matchedFormat: null
    };
    const fail = (reason: string) => {
        diagnostics.reason = reason;
        return { valid: false, diagnostics };
    };

    if (!secret.trim()) return fail("webhook_secret_missing");
    if (!rawBody?.length) return fail("raw_body_missing");
    if (header.length > 2048) return fail("signature_header_too_long");

    const parts = header.split(/[;,]/).map((part) => part.trim()).filter(Boolean);
    const timestampPart = parts.find((part) => /^t=\d+$/.test(part));
    const timestamp = timestampPart?.slice(2) ?? "";
    const signaturePart = parts.find((part) => /^(?:v1|sha256|signature)=/i.test(part))
        ?? parts.find((part) => part !== timestampPart);
    const signature = signaturePart?.replace(/^(?:v1|sha256|signature)=/i, "").trim() ?? "";
    diagnostics.timestamp = timestamp || null;
    diagnostics.signaturePresent = Boolean(signature);
    diagnostics.signaturePrefix = signaturePart?.match(/^(v1|sha256|signature)=/i)?.[1]?.toLowerCase() ?? null;
    diagnostics.signatureLength = signature.length;
    diagnostics.signatureEncoding = signature
        ? /^[a-f\d]{64}$/i.test(signature) ? "hex" : /^[A-Za-z\d+/]+={0,2}$/.test(signature) ? "base64" : "unknown"
        : null;
    if (!timestamp) return fail("timestamp_missing_or_malformed");
    if (!signature) return fail("signature_missing");

    const timestampNumber = Number(timestamp);
    const timestampSeconds = timestampNumber > 1_000_000_000_000 ? timestampNumber / 1000 : timestampNumber;
    diagnostics.timestampUnit = timestampNumber > 1_000_000_000_000 ? "milliseconds" : "seconds";
    if (!Number.isFinite(timestampSeconds)) return fail("timestamp_not_finite");
    diagnostics.timestampAgeSeconds = Math.round((Date.now() / 1000 - timestampSeconds) * 100) / 100;
    if (Math.abs(diagnostics.timestampAgeSeconds) > maxInfisicalWebhookAgeSeconds) return fail("timestamp_outside_five_minute_window");

    // Accept Infisical's project-webhook and webhook-channel signing inputs,
    // always using the exact raw request body and signed timestamp.
    const messages: Array<{ format: string; value: Buffer }> = [
        { format: "raw_body_then_timestamp", value: Buffer.concat([rawBody, Buffer.from(timestamp)]) },
        { format: "timestamp_dot_raw_body", value: Buffer.concat([Buffer.from(`${timestamp}.`), rawBody]) },
        { format: "timestamp_then_raw_body", value: Buffer.concat([Buffer.from(timestamp), rawBody]) }
    ];
    for (const { format, value } of messages) {
        const hmac = createHmac("sha256", secret).update(value).digest();
        const hexSignature = hmac.toString("hex");
        const base64Signature = hmac.toString("base64");
        diagnostics.checkedFormats.push(format);
        if (constantTimeEqual(hexSignature, signature.toLowerCase()) || constantTimeEqual(base64Signature, signature)) {
            diagnostics.reason = "verified";
            diagnostics.matchedFormat = format;
            return { valid: true, diagnostics };
        }
    }
    return fail("signature_did_not_match_checked_formats");
}

function constantTimeEqual(left: string, right: string) {
    const leftBuffer = Buffer.from(left);
    const rightBuffer = Buffer.from(right);
    return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}
