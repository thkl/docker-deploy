import { Server } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { AgentManager } from "./agentManager.js";
import { AdminAuth } from "./auth.js";
import { RuntimeLogStream } from "./deploy.js";
import { ServerStore } from "./serverStore.js";

/** Bridges browser container-log sockets to the selected Docker host agent. */
export class ContainerLogStreamHub {
    constructor(
        private readonly serverStore: ServerStore,
        private readonly agentManager: AgentManager,
        private readonly adminAuth: AdminAuth
    ) {}

    register(server: Server) {
        const webSocketServer = new WebSocketServer({ noServer: true });

        server.on("upgrade", (request, socket, head) => {
            const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
            const match = url.pathname.match(/^\/api\/containers\/([^/]+)\/([^/]+)\/logs\/stream$/);
            if (!match) {
                return;
            }

            let serverId: string;
            let containerId: string;
            try {
                serverId = decodeURIComponent(match[1]);
                containerId = decodeURIComponent(match[2]);
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

            const tail = Number(url.searchParams.get("tail") ?? 200);
            webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
                void this.registerClient(serverId, containerId, tail, webSocket);
            });
        });
    }

    private async registerClient(serverId: string, containerId: string, tail: number, webSocket: WebSocket) {
        let stream: RuntimeLogStream | undefined;
        let clientClosed = false;
        const send = (payload: unknown) => {
            if (webSocket.readyState === WebSocket.OPEN) {
                webSocket.send(JSON.stringify(payload));
            }
        };

        webSocket.on("close", () => {
            clientClosed = true;
            stream?.stop();
        });
        send({ type: "status", status: "connecting" });

        try {
            stream = await this.agentManager.getClient(serverId).followContainerLogs(containerId, tail, {
                onOutput: (stream, chunk) => send({ type: "log", stream, chunk }),
                onClose: () => {
                    send({ type: "status", status: "closed" });
                    webSocket.close();
                },
                onFailure: (error) => {
                    send({ type: "error", error: error.message });
                    webSocket.close();
                }
            });
            if (clientClosed) {
                stream.stop();
                return;
            }
            send({ type: "status", status: "live" });
        } catch (error) {
            send({ type: "error", error: error instanceof Error ? error.message : "Could not start container log stream." });
            webSocket.close();
        }
    }
}
