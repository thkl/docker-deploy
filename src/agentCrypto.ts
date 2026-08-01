import { createCipheriv, createDecipheriv, privateDecrypt, publicEncrypt, randomBytes, sign, verify } from "node:crypto";

export interface AgentKeyMaterial {
    encryptionPublicKey: string;
    encryptionPrivateKey: string;
    signingPublicKey: string;
    signingPrivateKey: string;
}

export interface SecureEnvelope {
    senderId: string;
    recipientId: string;
    messageType: string;
    timestamp: string;
    nonce: string;
    encryptedKey: string;
    iv: string;
    authTag: string;
    ciphertext: string;
    signature: string;
}

export interface EnvelopeKeys {
    senderSigningPrivateKey: string;
    recipientEncryptionPublicKey: string;
}

export interface OpenEnvelopeKeys {
    senderSigningPublicKey: string;
    recipientEncryptionPrivateKey: string;
}

const maxEnvelopeAgeMs = 5 * 60 * 1000;

/**
 * Encrypts and signs a JSON payload for another Deploy runtime.
 */
export function sealEnvelope(payload: unknown, metadata: Pick<SecureEnvelope, "senderId" | "recipientId" | "messageType">, keys: EnvelopeKeys): SecureEnvelope {
    const aesKey = randomBytes(32);
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", aesKey, iv);
    const plaintext = Buffer.from(JSON.stringify(payload), "utf8");
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const authTag = cipher.getAuthTag();
    const encryptedKey = publicEncrypt({ key: keys.recipientEncryptionPublicKey, oaepHash: "sha256" }, aesKey);
    const unsigned = {
        ...metadata,
        timestamp: new Date().toISOString(),
        nonce: randomBytes(16).toString("base64url"),
        encryptedKey: encryptedKey.toString("base64"),
        iv: iv.toString("base64"),
        authTag: authTag.toString("base64"),
        ciphertext: ciphertext.toString("base64")
    };

    return {
        ...unsigned,
        signature: sign(null, Buffer.from(canonicalJson(unsigned)), keys.senderSigningPrivateKey).toString("base64")
    };
}

/**
 * Verifies, decrypts, and parses a secure envelope.
 */
export function openEnvelope<T>(envelope: SecureEnvelope, expectedRecipientId: string, keys: OpenEnvelopeKeys): T {
    if (envelope.recipientId !== expectedRecipientId) {
        throw new Error("Envelope recipient does not match this runtime.");
    }

    const age = Math.abs(Date.now() - new Date(envelope.timestamp).getTime());
    if (!Number.isFinite(age) || age > maxEnvelopeAgeMs) {
        throw new Error("Envelope timestamp is outside the allowed window.");
    }

    const { signature, ...unsigned } = envelope;
    const validSignature = verify(null, Buffer.from(canonicalJson(unsigned)), keys.senderSigningPublicKey, Buffer.from(signature, "base64"));
    if (!validSignature) {
        throw new Error("Envelope signature is invalid.");
    }

    const aesKey = privateDecrypt({ key: keys.recipientEncryptionPrivateKey, oaepHash: "sha256" }, Buffer.from(envelope.encryptedKey, "base64"));
    const decipher = createDecipheriv("aes-256-gcm", aesKey, Buffer.from(envelope.iv, "base64"));
    decipher.setAuthTag(Buffer.from(envelope.authTag, "base64"));
    const plaintext = Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, "base64")), decipher.final()]);
    return JSON.parse(plaintext.toString("utf8")) as T;
}

/**
 * Produces a stable JSON string for signature verification.
 */
function canonicalJson(value: unknown): string {
    if (Array.isArray(value)) {
        return `[${value.map(canonicalJson).join(",")}]`;
    }

    if (value && typeof value === "object") {
        return `{${Object.entries(value)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
            .join(",")}}`;
    }

    return JSON.stringify(value);
}
