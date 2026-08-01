import crypto from "node:crypto";
import { Request, Response } from "express";
import { AuthenticatedRequest } from "./types.js";

/**
 * Verifies the configured webhook secret against the incoming request.
 *
 * GitLab sends the shared secret in `X-Gitlab-Token`. The older Svix-style HMAC
 * verifier is kept as a fallback for webhook sources that use signed payloads.
 */
export function verifySignature(repoToken: string, req: Request, res: Response) {
    const result = verifySignatureDetailed(repoToken, req);
    if (result.valid) {
        return true;
    }

    if (result.logMessage) {
        console.warn(result.logMessage);
    }

    res.status(result.statusCode).send(result.response);
    return false;
}

export interface SignatureVerificationResult {
    valid: boolean;
    statusCode: number;
    reason: string;
    response: string;
    logMessage?: string;
}

/**
 * Verifies a webhook signature without writing to the HTTP response.
 */
export function verifySignatureDetailed(repoToken: string, req: Request): SignatureVerificationResult {
    try {
        const gitlabToken = readHeader(req.headers["x-gitlab-token"]);
        if (gitlabToken) {
            if (gitlabToken.length === repoToken.length && crypto.timingSafeEqual(Buffer.from(gitlabToken), Buffer.from(repoToken))) {
                return validSignature();
            }

            return invalidSignature("invalid-gitlab-token", "Forbidden: Invalid webhook token.", "Unauthorized: Invalid GitLab webhook token.");
        }

        const authReq = req as AuthenticatedRequest;
        const webhookId = readHeader(req.headers["webhook-id"]);
        const webhookTimestamp = readHeader(req.headers["webhook-timestamp"]);
        const webhookSignatureHeader = readHeader(req.headers["webhook-signature"]);
        if (!webhookId || !webhookTimestamp || !webhookSignatureHeader) {
            return invalidSignature("missing-webhook-signature", "Forbidden: Missing webhook signature.");
        }

        const secretKeyRaw = repoToken.replace(/^whsec_/, "");
        const secretBuffer = Buffer.from(secretKeyRaw, "base64");
        const rawBodyString = authReq.rawBody ? authReq.rawBody.toString("utf8") : "";
        const messageToSign = `${webhookId}.${webhookTimestamp}.${rawBodyString}`;
        const computedHmac = crypto
            .createHmac("sha256", secretBuffer)
            .update(messageToSign)
            .digest("base64");

        const expectedSignature = `v1,${computedHmac}`;
        const signaturesReceived = webhookSignatureHeader.split(" ");
        let isSignatureValid = false;

        for (const sig of signaturesReceived) {
            if (sig.length === expectedSignature.length &&
                crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expectedSignature))) {
                isSignatureValid = true;
                break;
            }
        }

        if (!isSignatureValid) {
            return invalidSignature("invalid-webhook-signature", "Forbidden: Invalid webhook signature.", "Unauthorized: Invalid cryptographic signature.");
        }

        const currentTimestamp = Math.floor(Date.now() / 1000);
        const requestTimestamp = parseInt(webhookTimestamp, 10);
        if (Math.abs(currentTimestamp - requestTimestamp) > 300) {
            return invalidSignature("expired-webhook-signature", "Forbidden: Expired signature timestamp.", "Unauthorized: Webhook timestamp drifted too far (Replay Attack protection).");
        }
    } catch (err) {
        console.error("Signature calculation crash:", err);
        return {
            valid: false,
            statusCode: 500,
            reason: "signature-validation-error",
            response: "Internal validation error."
        };
    }

    return validSignature();
}

/**
 * Reads a single HTTP header value from Express' string-or-array header shape.
 */
function readHeader(value: string | string[] | undefined) {
    return Array.isArray(value) ? value[0] : value ?? "";
}

function validSignature(): SignatureVerificationResult {
    return {
        valid: true,
        statusCode: 200,
        reason: "valid",
        response: ""
    };
}

function invalidSignature(reason: string, response: string, logMessage?: string): SignatureVerificationResult {
    return {
        valid: false,
        statusCode: 403,
        reason,
        response,
        ...(logMessage ? { logMessage } : {})
    };
}
