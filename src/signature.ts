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
    try {
        const gitlabToken = readHeader(req.headers["x-gitlab-token"]);
        if (gitlabToken) {
            if (gitlabToken.length === repoToken.length && crypto.timingSafeEqual(Buffer.from(gitlabToken), Buffer.from(repoToken))) {
                return true;
            }

            console.warn("Unauthorized: Invalid GitLab webhook token.");
            res.status(403).send("Forbidden: Invalid webhook token.");
            return false;
        }

        const authReq = req as AuthenticatedRequest;
        const webhookId = readHeader(req.headers["webhook-id"]);
        const webhookTimestamp = readHeader(req.headers["webhook-timestamp"]);
        const webhookSignatureHeader = readHeader(req.headers["webhook-signature"]);
        if (!webhookId || !webhookTimestamp || !webhookSignatureHeader) {
            res.status(403).send("Forbidden: Missing webhook signature.");
            return false;
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
            console.warn("Unauthorized: Invalid cryptographic signature.");
            res.status(403).send("Forbidden: Invalid webhook signature.");
            return false;
        }

        const currentTimestamp = Math.floor(Date.now() / 1000);
        const requestTimestamp = parseInt(webhookTimestamp, 10);
        if (Math.abs(currentTimestamp - requestTimestamp) > 300) {
            console.warn("Unauthorized: Webhook timestamp drifted too far (Replay Attack protection).");
            res.status(403).send("Forbidden: Expired signature timestamp.");
            return false;
        }
    } catch (err) {
        console.error("Signature calculation crash:", err);
        res.status(500).send("Internal validation error.");
        return false;
    }

    return true;
}

/**
 * Reads a single HTTP header value from Express' string-or-array header shape.
 */
function readHeader(value: string | string[] | undefined) {
    return Array.isArray(value) ? value[0] : value ?? "";
}
