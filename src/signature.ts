import crypto from "node:crypto";
import { Request, Response } from "express";
import { AuthenticatedRequest } from "./types.js";

export function verifySignature(repoToken: string, req: Request, res: Response) {
    try {
        const authReq = req as AuthenticatedRequest;
        const webhookId = req.headers["webhook-id"] as string;
        const webhookTimestamp = req.headers["webhook-timestamp"] as string;
        const webhookSignatureHeader = req.headers["webhook-signature"] as string;
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
