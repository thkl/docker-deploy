import { generateKeyPairSync, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { AgentKeyMaterial } from "./agentCrypto.js";

export interface ControllerKeyState extends AgentKeyMaterial {
    controllerId: string;
}

export interface AgentState extends AgentKeyMaterial {
    serverId: string;
    pairingToken: string;
    controllerId?: string;
    controllerPublicEncryptionKey?: string;
    controllerPublicSigningKey?: string;
    pairedAt?: string;
    seenNonces: Record<string, string>;
}

/**
 * Loads or creates the controller key material stored under the data volume.
 */
export function ensureControllerKeys(path = join("./data", "controller-keys.json")): ControllerKeyState {
    if (existsSync(path)) {
        return JSON.parse(readFileSync(path, "utf8")) as ControllerKeyState;
    }

    const state: ControllerKeyState = {
        controllerId: "controller",
        ...generateRuntimeKeys()
    };
    writeJson(path, state);
    return state;
}

/**
 * Loads or creates the agent state stored under the data volume.
 */
export function ensureAgentState(path = join("./data", "agent-state.json")): AgentState {
    if (existsSync(path)) {
        const loaded = JSON.parse(readFileSync(path, "utf8")) as AgentState;
        return { ...loaded, seenNonces: loaded.seenNonces ?? {} };
    }

    const state: AgentState = {
        serverId: process.env.UPDATER_SERVER_ID || `agent-${randomUUID().slice(0, 8)}`,
        pairingToken: randomUUID(),
        ...generateRuntimeKeys(),
        seenNonces: {}
    };
    writeJson(path, state);
    return state;
}

/**
 * Persists the full agent state.
 */
export function writeAgentState(state: AgentState, path = join("./data", "agent-state.json")) {
    writeJson(path, state);
}

/**
 * Marks a nonce as used and rejects replayed messages.
 */
export function rememberNonce(state: AgentState, nonce: string, timestamp: string) {
    const now = Date.now();
    const cutoff = now - 10 * 60 * 1000;
    for (const [storedNonce, storedTimestamp] of Object.entries(state.seenNonces)) {
        if (new Date(storedTimestamp).getTime() < cutoff) {
            delete state.seenNonces[storedNonce];
        }
    }

    if (state.seenNonces[nonce]) {
        throw new Error("Envelope nonce was already used.");
    }

    state.seenNonces[nonce] = timestamp;
}

/**
 * Creates one RSA encryption pair and one Ed25519 signing pair.
 */
function generateRuntimeKeys(): AgentKeyMaterial {
    const encryption = generateKeyPairSync("rsa", {
        modulusLength: 3072,
        publicKeyEncoding: { type: "spki", format: "pem" },
        privateKeyEncoding: { type: "pkcs8", format: "pem" }
    });
    const signing = generateKeyPairSync("ed25519", {
        publicKeyEncoding: { type: "spki", format: "pem" },
        privateKeyEncoding: { type: "pkcs8", format: "pem" }
    });

    return {
        encryptionPublicKey: encryption.publicKey,
        encryptionPrivateKey: encryption.privateKey,
        signingPublicKey: signing.publicKey,
        signingPrivateKey: signing.privateKey
    };
}

/**
 * Writes JSON state into the configured data volume.
 */
function writeJson(path: string, value: unknown) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}
