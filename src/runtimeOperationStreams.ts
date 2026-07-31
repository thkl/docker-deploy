import { Server } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { AgentManager } from "./agentManager.js";
import { AdminAuth } from "./auth.js";
import { ConfigStore } from "./configStore.js";
import { RuntimeLogStream } from "./deploy.js";
import { GlobalSettingsStore } from "./globalSettingsStore.js";
import { RuntimeOperationRecord, RuntimeOperationStore } from "./runtimeOperationStore.js";
import { ProjectSettings, RuntimeServiceAction } from "./types.js";
import { normalizeProjectName } from "./validation.js";

/**
 * Bridges browser WebSockets to service-level runtime actions and persists the
 * final operation record when the command ends.
 */
export class RuntimeOperationStreamHub {
    constructor(
        private readonly configStore: ConfigStore,
        private readonly globalSettingsStore: GlobalSettingsStore,
        private readonly agentManager: AgentManager,
        private readonly runtimeOperationStore: RuntimeOperationStore,
        private readonly adminAuth: AdminAuth,
        private readonly refreshRuntimeStatus: (projectName: string) => void | Promise<void> = () => {},
        private readonly publishRuntimeOperation: (projectName: string, operation: RuntimeOperationRecord) => void = () => {}
    ) {}

    /**
     * Handles HTTP upgrades for `/api/projects/:name/runtime-actions/stream`.
     */
    register(server: Server) {
        const webSocketServer = new WebSocketServer({ noServer: true });

        server.on("upgrade", (request, socket, head) => {
            const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
            const match = url.pathname.match(/^\/api\/projects\/([^/]+)\/runtime-actions\/stream$/);
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
            const action = (url.searchParams.get("action") ?? "").trim() as RuntimeServiceAction;
            if (!project) {
                socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
                socket.destroy();
                return;
            }

            if (!service || !isRuntimeServiceAction(action)) {
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
                void this.registerClient(project.name, project.settings, service, action, webSocket);
            });
        });
    }

    private async registerClient(projectName: string, appSettings: ProjectSettings, service: string, action: RuntimeServiceAction, webSocket: WebSocket) {
        let stream: RuntimeLogStream | undefined;
        let output = "";
        let finished = false;
        const startedAt = new Date().toISOString();
        const send = (payload: unknown) => {
            if (webSocket.readyState === WebSocket.OPEN) {
                webSocket.send(JSON.stringify(payload));
            }
        };
        const appendOutput = (streamName: "stdout" | "stderr", chunk: string) => {
            output += streamName === "stderr" ? `[stderr] ${chunk}` : chunk;
            send({ type: "log", stream: streamName, chunk });
        };
        const finish = (status: "succeeded" | "failed", error?: string) => {
            if (finished) {
                return;
            }

            finished = true;
            const record = this.runtimeOperationStore.record(projectName, {
                serverId: appSettings.serverId ?? "local",
                service,
                action,
                status,
                startedAt,
                finishedAt: new Date().toISOString(),
                ...(error ? { error } : {}),
                output: output.trim() || error || ""
            });
            void this.refreshRuntimeStatus(projectName);
            this.publishRuntimeOperation(projectName, record);
            send({ type: "operation", operation: record });
            send({ type: "status", status: status === "succeeded" ? "closed" : "error" });
            webSocket.close();
        };

        webSocket.on("close", () => {
            if (!finished && !stream) {
                finished = true;
            }
        });
        send({ type: "status", status: "connecting" });

        try {
            stream = await this.agentManager.getClient(appSettings.serverId ?? "local").followRuntimeAction(projectName, appSettings, this.globalSettingsStore.readSettings(), service, action, {
                onOutput: appendOutput,
                onClose: () => finish("succeeded"),
                onFailure: (error) => finish("failed", error.message)
            });
            send({ type: "status", status: "live" });
        } catch (error) {
            finish("failed", error instanceof Error ? error.message : "Could not start runtime action.");
        }
    }
}

function isRuntimeServiceAction(value: string): value is RuntimeServiceAction {
    return ["restart", "start", "stop", "recreate", "pull"].includes(value);
}
