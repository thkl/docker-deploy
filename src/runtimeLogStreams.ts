import { Server } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { AgentManager } from "./agentManager.js";
import { AdminAuth } from "./auth.js";
import { ConfigStore } from "./configStore.js";
import { GlobalSettingsStore } from "./globalSettingsStore.js";
import { RuntimeLogStream } from "./deploy.js";
import { normalizeProjectName } from "./validation.js";

/**
 * Bridges browser WebSockets to target-agent runtime log streams.
 */
export class RuntimeLogStreamHub {
    constructor(
        private readonly configStore: ConfigStore,
        private readonly globalSettingsStore: GlobalSettingsStore,
        private readonly agentManager: AgentManager,
        private readonly adminAuth: AdminAuth
    ) {}

    /**
     * Handles HTTP upgrade requests for `/api/projects/:name/runtime-logs/stream`.
     */
    register(server: Server) {
        const webSocketServer = new WebSocketServer({ noServer: true });

        server.on("upgrade", (request, socket, head) => {
            const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
            const match = url.pathname.match(/^\/api\/projects\/([^/]+)\/runtime-logs\/stream$/);
            if (!match) {
                return;
            }

            let projectRef = "";
            try {
                projectRef = normalizeProjectName(decodeURIComponent(match[1]));
            } catch (error) {
                socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
                socket.destroy();
                return;
            }

            const project = this.configStore.resolveProject(projectRef);
            const service = (url.searchParams.get("service") ?? "").trim();
            const tail = Number(url.searchParams.get("tail") ?? 200);
            if (!project) {
                socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
                socket.destroy();
                return;
            }

            if (!service) {
                socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
                socket.destroy();
                return;
            }

            if (!this.adminAuth.isValidToken(url.searchParams.get("token") ?? "")) {
                socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
                socket.destroy();
                return;
            }

            webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
                void this.registerClient(project.name, project.settings, service, tail, webSocket);
            });
        });
    }

    /**
     * Opens one runtime log stream and closes it with the browser socket.
     */
    private async registerClient(projectName: string, appSettings: NonNullable<ReturnType<ConfigStore["resolveProject"]>>["settings"], service: string, tail: number, webSocket: WebSocket) {
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
            stream = await this.agentManager.getClient(appSettings.serverId ?? "local").followRuntimeLogs(projectName, appSettings, this.globalSettingsStore.readSettings(), service, tail, {
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
            send({ type: "error", error: error instanceof Error ? error.message : "Could not start runtime log stream." });
            webSocket.close();
        }
    }
}
