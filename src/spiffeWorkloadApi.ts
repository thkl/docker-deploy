import { createPrivateKey, X509Certificate } from "node:crypto";
import { connect as connectHttp2, constants as http2Constants, ClientHttp2Session, ClientHttp2Stream } from "node:http2";
import { connect as connectSocket } from "node:net";

const workloadApiTimeoutMs = 10_000;
const maxGrpcMessageBytes = 1_048_576;
const workloadApiSocketDefault = "unix:///run/spire/agent.sock";

export interface SpiffeX509Identity {
    spiffeId: string;
    certificate: string;
    privateKey: string;
}

interface EncodedField {
    number: number;
    wireType: number;
    bytes?: Buffer;
}

/** Fetches the currently-issued X.509-SVID from the local SPIFFE Workload API. */
export async function fetchSpiffeX509Identity(expectedSpiffeId: string): Promise<SpiffeX509Identity> {
    const requestedId = expectedSpiffeId.trim();
    if (!isSpiffeId(requestedId)) {
        throw new Error("Enter the SPIFFE ID that ZeroSecrets should authorize, for example spiffe://example.org/updater.");
    }

    const socketPath = workloadApiSocketPath(process.env.SPIFFE_ENDPOINT_SOCKET || workloadApiSocketDefault);
    const response = await fetchWorkloadApiResponse(socketPath);
    const svids = readLengthDelimitedFields(response, 1)
        .map(readX509Svid)
        .filter((svid): svid is { spiffeId: string; certificateDer: Buffer; privateKeyDer: Buffer } => Boolean(svid));
    const selected = svids.find((svid) => svid.spiffeId === requestedId);
    if (!selected) {
        const available = svids.map((svid) => svid.spiffeId).filter(Boolean);
        throw new Error(available.length
            ? `SPIRE did not provide the configured identity '${requestedId}'. Available identity: ${available.join(", ")}.`
            : "SPIRE returned no X.509-SVIDs for the updater workload.");
    }

    const certificate = derCertificateChainToPem(selected.certificateDer);
    const key = createPrivateKey({ key: selected.privateKeyDer, format: "der", type: "pkcs8" });
    const privateKey = key.export({ format: "pem", type: "pkcs8" }).toString();
    const leaf = new X509Certificate(selected.certificateDer.subarray(0, derObjectLength(selected.certificateDer, 0)));
    if (!containsUriSan(leaf.subjectAltName, requestedId)) {
        throw new Error(`SPIRE returned an X.509 certificate whose URI SAN does not match '${requestedId}'.`);
    }

    return { spiffeId: requestedId, certificate, privateKey };
}

function fetchWorkloadApiResponse(socketPath: string): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        let session: ClientHttp2Session | undefined;
        let stream: ClientHttp2Stream | undefined;
        let responseStatus: number | undefined;
        let grpcStatus: string | undefined;
        let responseBytes = Buffer.alloc(0);
        let settled = false;

        const timer = setTimeout(() => finish(new Error("Timed out while requesting an X.509-SVID from the SPIFFE Workload API.")), workloadApiTimeoutMs);
        timer.unref();

        const finish = (error?: Error, result?: Buffer) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            stream?.close(http2Constants.NGHTTP2_CANCEL);
            session?.close();
            if (error) reject(error);
            else resolve(result ?? Buffer.alloc(0));
        };

        try {
            session = connectHttp2("http://localhost", {
                createConnection: () => connectSocket({ path: socketPath })
            });
        } catch {
            finish(new Error(`Could not connect to the SPIFFE Workload API socket '${socketPath}'.`));
            return;
        }

        session.on("error", () => finish(new Error(`Could not connect to the SPIFFE Workload API socket '${socketPath}'.`)));
        stream = session.request({
            ":method": "POST",
            ":path": "/SpiffeWorkloadAPI/FetchX509SVID",
            "content-type": "application/grpc",
            "te": "trailers",
            "grpc-encoding": "identity"
        });
        stream.on("response", (headers) => {
            responseStatus = Number(headers[":status"]);
            if (responseStatus !== 200) finish(new Error(`SPIFFE Workload API returned HTTP ${responseStatus || "an invalid response"}.`));
        });
        stream.on("trailers", (headers) => {
            const value = headers["grpc-status"];
            grpcStatus = Array.isArray(value) ? String(value[0] ?? "") : value === undefined ? undefined : String(value);
        });
        stream.on("data", (chunk: Buffer | string) => {
            if (settled) return;
            const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            responseBytes = Buffer.concat([responseBytes, bytes]);
            if (responseBytes.length > maxGrpcMessageBytes + 5) {
                finish(new Error("SPIFFE Workload API response exceeded the allowed size."));
                return;
            }
            let payload: Buffer | undefined;
            try {
                payload = firstGrpcPayload(responseBytes);
            } catch (error) {
                finish(error instanceof Error ? error : new Error("SPIFFE Workload API returned an invalid gRPC response."));
                return;
            }
            if (payload) {
                if (responseStatus !== 200) {
                    finish(new Error("SPIFFE Workload API returned an invalid HTTP response."));
                    return;
                }
                finish(undefined, payload);
            }
        });
        stream.on("end", () => {
            if (settled) return;
            if (grpcStatus && grpcStatus !== "0") {
                finish(new Error(`SPIFFE Workload API failed with gRPC status ${grpcStatus}.`));
            } else {
                finish(new Error("SPIFFE Workload API ended without returning an X.509-SVID."));
            }
        });
        stream.on("error", () => finish(new Error("The SPIFFE Workload API request failed.")));
        stream.end(grpcFrame(Buffer.alloc(0)));
    });
}

function grpcFrame(payload: Buffer) {
    const header = Buffer.alloc(5);
    header.writeUInt8(0, 0);
    header.writeUInt32BE(payload.length, 1);
    return Buffer.concat([header, payload]);
}

function firstGrpcPayload(bytes: Buffer) {
    if (bytes.length < 5) return undefined;
    const compressed = bytes.readUInt8(0);
    const length = bytes.readUInt32BE(1);
    if (compressed !== 0) throw new Error("SPIFFE Workload API returned a compressed gRPC message that is not supported.");
    if (length > maxGrpcMessageBytes) throw new Error("SPIFFE Workload API response exceeded the allowed size.");
    if (bytes.length < 5 + length) return undefined;
    return bytes.subarray(5, 5 + length);
}

function readX509Svid(message: Buffer) {
    let spiffeId = "";
    let certificateDer: Buffer | undefined;
    let privateKeyDer: Buffer | undefined;
    for (const field of protobufFields(message)) {
        if (field.wireType !== 2 || !field.bytes) continue;
        if (field.number === 1) spiffeId = field.bytes.toString("utf8");
        if (field.number === 2) certificateDer = field.bytes;
        if (field.number === 3) privateKeyDer = field.bytes;
    }
    return spiffeId && certificateDer?.length && privateKeyDer?.length
        ? { spiffeId, certificateDer, privateKeyDer }
        : undefined;
}

function readLengthDelimitedFields(message: Buffer, fieldNumber: number) {
    return [...protobufFields(message)]
        .filter((field) => field.number === fieldNumber && field.wireType === 2 && field.bytes)
        .map((field) => field.bytes as Buffer);
}

function* protobufFields(message: Buffer): Generator<EncodedField> {
    let offset = 0;
    while (offset < message.length) {
        const tag = readVarint(message, offset);
        offset = tag.offset;
        const fieldNumber = Math.floor(tag.value / 8);
        const wireType = tag.value & 7;
        if (!fieldNumber) throw new Error("SPIFFE Workload API returned malformed protobuf data.");

        if (wireType === 2) {
            const length = readVarint(message, offset);
            offset = length.offset;
            const end = offset + length.value;
            if (end > message.length) throw new Error("SPIFFE Workload API returned truncated protobuf data.");
            yield { number: fieldNumber, wireType, bytes: message.subarray(offset, end) };
            offset = end;
            continue;
        }
        if (wireType === 0) {
            const value = readVarint(message, offset);
            offset = value.offset;
            yield { number: fieldNumber, wireType };
            continue;
        }
        if (wireType === 1 || wireType === 5) {
            const width = wireType === 1 ? 8 : 4;
            if (offset + width > message.length) throw new Error("SPIFFE Workload API returned truncated protobuf data.");
            offset += width;
            yield { number: fieldNumber, wireType };
            continue;
        }
        throw new Error("SPIFFE Workload API returned unsupported protobuf data.");
    }
}

function readVarint(message: Buffer, start: number) {
    let value = 0n;
    let shift = 0n;
    let offset = start;
    while (offset < message.length && offset - start < 10) {
        const byte = message[offset++];
        value |= BigInt(byte & 0x7f) << shift;
        if ((byte & 0x80) === 0) {
            const number = Number(value);
            if (!Number.isSafeInteger(number)) throw new Error("SPIFFE Workload API returned an oversized protobuf value.");
            return { value: number, offset };
        }
        shift += 7n;
    }
    throw new Error("SPIFFE Workload API returned malformed protobuf data.");
}

function derCertificateChainToPem(chain: Buffer) {
    const certificates: string[] = [];
    let offset = 0;
    while (offset < chain.length) {
        const length = derObjectLength(chain, offset);
        const derCertificate = chain.subarray(offset, offset + length);
        certificates.push(`-----BEGIN CERTIFICATE-----\n${derCertificate.toString("base64").match(/.{1,64}/g)?.join("\n")}\n-----END CERTIFICATE-----`);
        offset += length;
    }
    if (!certificates.length) throw new Error("SPIRE returned an empty X.509 certificate chain.");
    return certificates.join("\n");
}

function derObjectLength(bytes: Buffer, offset: number) {
    if (offset + 2 > bytes.length || bytes[offset] !== 0x30) {
        throw new Error("SPIRE returned an invalid DER-encoded X.509 certificate.");
    }
    const firstLength = bytes[offset + 1];
    let headerLength = 2;
    let contentLength = firstLength;
    if (firstLength & 0x80) {
        const lengthBytes = firstLength & 0x7f;
        if (!lengthBytes || lengthBytes > 4 || offset + 2 + lengthBytes > bytes.length) {
            throw new Error("SPIRE returned an invalid DER-encoded X.509 certificate.");
        }
        headerLength += lengthBytes;
        contentLength = 0;
        for (let index = 0; index < lengthBytes; index += 1) {
            contentLength = contentLength * 256 + bytes[offset + 2 + index];
        }
    }
    const totalLength = headerLength + contentLength;
    if (offset + totalLength > bytes.length) throw new Error("SPIRE returned a truncated DER-encoded X.509 certificate.");
    return totalLength;
}

function workloadApiSocketPath(endpoint: string) {
    const value = endpoint.trim();
    const path = value.startsWith("unix://") ? value.slice("unix://".length) : value;
    if (!path.startsWith("/")) {
        throw new Error("SPIFFE_ENDPOINT_SOCKET must point to a local Unix socket, for example unix:///run/spire/agent.sock.");
    }
    return path;
}

function isSpiffeId(value: string) {
    return /^spiffe:\/\/[A-Za-z0-9.-]+\/.+/.test(value) && !/[\s?#]/.test(value);
}

function containsUriSan(subjectAltName: string | undefined, spiffeId: string) {
    if (!subjectAltName) return false;
    let entry = "";
    let inJsonString = false;
    let escaped = false;
    const entries: string[] = [];
    for (const character of subjectAltName) {
        if (character === "," && !inJsonString) {
            entries.push(entry.trim());
            entry = "";
            continue;
        }
        entry += character;
        if (inJsonString) {
            if (escaped) escaped = false;
            else if (character === "\\") escaped = true;
            else if (character === '"') inJsonString = false;
        } else if (character === '"') {
            inJsonString = true;
        }
    }
    if (entry.trim()) entries.push(entry.trim());

    return entries.some((san) => {
        const colon = san.indexOf(":");
        if (colon < 0 || san.slice(0, colon) !== "URI") return false;
        const value = san.slice(colon + 1).trim();
        if (!value.startsWith('"')) return value === spiffeId;
        try {
            return JSON.parse(value) === spiffeId;
        } catch {
            return false;
        }
    });
}
