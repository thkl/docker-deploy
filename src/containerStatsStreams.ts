import { Server } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { AgentManager } from "./agentManager.js";
import { AdminAuth } from "./auth.js";
import { RuntimeLogStream } from "./deploy.js";
import { ContainerStatsSample } from "./types.js";
import { ServerStore } from "./serverStore.js";

interface DockerStatsRow {
    ID?: string;
    Container?: string;
    Name?: string;
    CPUPerc?: string;
    MemUsage?: string;
    MemPerc?: string;
    NetIO?: string;
    BlockIO?: string;
    PIDs?: string;
}

interface ServerStatsFeed {
    clients: Set<WebSocket>;
    pendingSamples: Map<string, ContainerStatsSample>;
    stream?: RuntimeLogStream;
    flushTimer?: ReturnType<typeof setTimeout>;
    keepAlive?: ReturnType<typeof setInterval>;
    buffer: string;
    starting: boolean;
    live: boolean;
    stopped: boolean;
}

/** Shares one live Docker stats stream per server among connected browser clients. */
export class ContainerStatsStreamHub {
    private readonly feeds = new Map<string, ServerStatsFeed>();

    constructor(
        private readonly serverStore: ServerStore,
        private readonly agentManager: AgentManager,
        private readonly adminAuth: AdminAuth
    ) {}

    register(server: Server) {
        const webSocketServer = new WebSocketServer({ noServer: true });
        server.on("upgrade", (request, socket, head) => {
            const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
            const match = url.pathname.match(/^\/api\/containers\/([^/]+)\/stats\/stream$/);
            if (!match) return;

            let serverId: string;
            try {
                serverId = decodeURIComponent(match[1]);
            } catch {
                socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
                socket.destroy();
                return;
            }
            if (!this.serverStore.get(serverId)) {
                socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
                socket.destroy();
                return;
            }
            if (!this.adminAuth.isValidToken(url.searchParams.get("token") ?? "")) {
                socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
                socket.destroy();
                return;
            }

            webSocketServer.handleUpgrade(request, socket, head, (webSocket) => this.registerClient(serverId, webSocket));
        });
    }

    private registerClient(serverId: string, webSocket: WebSocket) {
        let feed = this.feeds.get(serverId);
        if (!feed) {
            feed = {
                clients: new Set(),
                pendingSamples: new Map(),
                buffer: "",
                starting: false,
                live: false,
                stopped: false
            };
            this.feeds.set(serverId, feed);
        }

        feed.clients.add(webSocket);
        if (!feed.keepAlive) {
            feed.keepAlive = setInterval(() => {
                for (const client of feed!.clients) {
                    if (client.readyState === WebSocket.OPEN) client.ping();
                }
            }, 20_000);
        }
        this.send(webSocket, { type: "status", status: feed.live ? "live" : "connecting" });
        webSocket.on("close", () => this.removeClient(serverId, feed!, webSocket));
        webSocket.on("error", () => this.removeClient(serverId, feed!, webSocket));

        if (!feed.starting && !feed.stream) {
            void this.startFeed(serverId, feed);
        }
    }

    private async startFeed(serverId: string, feed: ServerStatsFeed) {
        feed.starting = true;
        try {
            const stream = await this.agentManager.getClient(serverId).followContainerStats({
                onOutput: (channel, chunk) => {
                    if (channel === "stdout") this.handleOutput(feed, chunk);
                },
                onClose: () => this.finishFeed(serverId, feed),
                onFailure: (error) => this.failFeed(serverId, feed, error.message)
            });
            feed.starting = false;
            if (feed.stopped || this.feeds.get(serverId) !== feed) {
                stream.stop();
                return;
            }
            feed.stream = stream;
            feed.live = true;
            this.broadcast(feed, { type: "status", status: "live" });
        } catch (error) {
            feed.starting = false;
            if (!feed.stopped) {
                this.failFeed(serverId, feed, error instanceof Error ? error.message : "Could not start Docker stats stream.");
            }
        }
    }

    private handleOutput(feed: ServerStatsFeed, chunk: string) {
        const lines = `${feed.buffer}${chunk}`.split(/\r?\n/);
        feed.buffer = lines.pop() ?? "";
        if (feed.buffer.length > 64_000) feed.buffer = "";

        for (const line of lines) {
            const sample = parseStatsLine(line);
            if (sample) feed.pendingSamples.set(sample.id || sample.name, sample);
        }
        if (feed.pendingSamples.size && !feed.flushTimer) {
            feed.flushTimer = setTimeout(() => this.flushSamples(feed), 100);
        }
    }

    private flushSamples(feed: ServerStatsFeed) {
        feed.flushTimer = undefined;
        const samples = [...feed.pendingSamples.values()];
        feed.pendingSamples.clear();
        if (samples.length) this.broadcast(feed, { type: "stats", samples });
    }

    private finishFeed(serverId: string, feed: ServerStatsFeed) {
        if (feed.stopped) return;
        this.broadcast(feed, { type: "status", status: "closed" });
        for (const client of feed.clients) client.close();
        this.stopFeed(serverId, feed);
    }

    private failFeed(serverId: string, feed: ServerStatsFeed, error: string) {
        if (feed.stopped) return;
        this.broadcast(feed, { type: "error", error });
        for (const client of feed.clients) client.close();
        this.stopFeed(serverId, feed);
    }

    private removeClient(serverId: string, feed: ServerStatsFeed, webSocket: WebSocket) {
        feed.clients.delete(webSocket);
        if (!feed.clients.size) this.stopFeed(serverId, feed);
    }

    private stopFeed(serverId: string, feed: ServerStatsFeed) {
        feed.stopped = true;
        if (this.feeds.get(serverId) === feed) this.feeds.delete(serverId);
        if (feed.flushTimer) clearTimeout(feed.flushTimer);
        if (feed.keepAlive) clearInterval(feed.keepAlive);
        feed.stream?.stop();
    }

    private broadcast(feed: ServerStatsFeed, payload: unknown) {
        for (const client of feed.clients) this.send(client, payload);
    }

    private send(webSocket: WebSocket, payload: unknown) {
        if (webSocket.readyState === WebSocket.OPEN && webSocket.bufferedAmount < 1_000_000) {
            webSocket.send(JSON.stringify(payload));
        }
    }
}

function parseStatsLine(line: string): ContainerStatsSample | undefined {
    if (!line.trim()) return undefined;
    try {
        const row = JSON.parse(line) as DockerStatsRow;
        const id = row.ID?.trim() || row.Container?.trim();
        const name = row.Name?.trim() || id;
        if (!id || !name) return undefined;
        const cpuPercent = parsePercent(row.CPUPerc);
        const memoryPercent = parsePercent(row.MemPerc);
        const processCount = Number(row.PIDs);
        return {
            id,
            name,
            checkedAt: new Date().toISOString(),
            ...(cpuPercent !== undefined ? { cpuPercent } : {}),
            ...(row.MemUsage ? { memoryUsage: row.MemUsage } : {}),
            ...(memoryPercent !== undefined ? { memoryPercent } : {}),
            ...(row.NetIO ? { networkIo: row.NetIO } : {}),
            ...(row.BlockIO ? { blockIo: row.BlockIO } : {}),
            ...(Number.isFinite(processCount) ? { processCount } : {})
        };
    } catch {
        return undefined;
    }
}

function parsePercent(value?: string) {
    if (!value) return undefined;
    const parsed = Number.parseFloat(value.replace("%", "").trim());
    return Number.isFinite(parsed) ? parsed : undefined;
}
