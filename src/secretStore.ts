import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const secretPrefix = "deploy:v1";
const keyBytes = 32;
const ivBytes = 12;

interface ControllerSecretKeyFile {
    version: 1;
    algorithm: "aes-256-gcm";
    key: string;
}

/**
 * Loads or creates the symmetric controller key used for database secrets.
 */
export function ensureControllerSecretKey(path = join("./data", "controller-secret-key.json")) {
    const envKey = process.env.DEPLOY_SECRET_KEY || process.env.UPDATER_SECRET_KEY;
    if (envKey) {
        return parseSecretKey(envKey, "DEPLOY_SECRET_KEY");
    }

    if (existsSync(path)) {
        const state = JSON.parse(readFileSync(path, "utf8")) as ControllerSecretKeyFile;
        return parseSecretKey(state.key, path);
    }

    const key = randomBytes(keyBytes);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify({ version: 1, algorithm: "aes-256-gcm", key: key.toString("base64") }, null, 2)}\n`, { mode: 0o600 });
    return key;
}

export function isEncryptedSecret(value?: string | null) {
    return Boolean(value?.startsWith(`${secretPrefix}:`));
}

export function encryptSecret(value?: string | null) {
    if (!value || isEncryptedSecret(value)) {
        return value ?? null;
    }

    const key = ensureControllerSecretKey();
    const iv = randomBytes(ivBytes);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [secretPrefix, iv.toString("base64"), tag.toString("base64"), ciphertext.toString("base64")].join(":");
}

export function decryptSecret(value?: string | null) {
    if (!value || !isEncryptedSecret(value)) {
        return value ?? undefined;
    }

    const [, , ivEncoded, tagEncoded, ciphertextEncoded] = value.split(":");
    if (!ivEncoded || !tagEncoded || !ciphertextEncoded) {
        throw new Error("Stored secret has an invalid encrypted format.");
    }

    const key = ensureControllerSecretKey();
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivEncoded, "base64"));
    decipher.setAuthTag(Buffer.from(tagEncoded, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(ciphertextEncoded, "base64")), decipher.final()]).toString("utf8");
}

function parseSecretKey(value: string, source: string) {
    const key = Buffer.from(value, "base64");
    if (key.length !== keyBytes) {
        throw new Error(`${source} must contain a ${keyBytes}-byte base64 encoded key.`);
    }

    return key;
}
