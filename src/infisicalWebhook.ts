import { createHmac, timingSafeEqual } from "node:crypto";

const maxInfisicalWebhookAgeSeconds = 300;

/** Verify Infisical's signed project webhook using the exact captured body. */
export function verifyInfisicalWebhookSignature(secret: string, header: string, rawBody: Buffer | undefined) {
    if (!secret.trim() || !rawBody?.length || header.length > 2048) return false;

    const parts = header.split(/[;,]/).map((part) => part.trim()).filter(Boolean);
    const timestampPart = parts.find((part) => /^t=\d+$/.test(part));
    const timestamp = timestampPart?.slice(2) ?? "";
    const signaturePart = parts.find((part) => /^(?:v1|sha256|signature)=/i.test(part))
        ?? parts.find((part) => part !== timestampPart);
    const signature = signaturePart?.replace(/^(?:v1|sha256|signature)=/i, "").trim() ?? "";
    if (!timestamp || !signature) return false;

    const timestampNumber = Number(timestamp);
    const timestampSeconds = timestampNumber > 1_000_000_000_000 ? timestampNumber / 1000 : timestampNumber;
    if (!Number.isFinite(timestampSeconds) || Math.abs(Date.now() / 1000 - timestampSeconds) > maxInfisicalWebhookAgeSeconds) {
        return false;
    }

    // Accept Infisical's project-webhook and webhook-channel signing inputs,
    // always using the exact raw request body and signed timestamp.
    const messages = [
        Buffer.concat([rawBody, Buffer.from(timestamp)]),
        Buffer.concat([Buffer.from(`${timestamp}.`), rawBody]),
        Buffer.concat([Buffer.from(timestamp), rawBody])
    ];
    for (const message of messages) {
        const hmac = createHmac("sha256", secret).update(message).digest();
        const hexSignature = hmac.toString("hex");
        const base64Signature = hmac.toString("base64");
        if (constantTimeEqual(hexSignature, signature.toLowerCase()) || constantTimeEqual(base64Signature, signature)) {
            return true;
        }
    }
    return false;
}

function constantTimeEqual(left: string, right: string) {
    const leftBuffer = Buffer.from(left);
    const rightBuffer = Buffer.from(right);
    return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}
