import { Server } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { AgentManager } from "./agentManager.js";
import { AdminAuth } from "./auth.js";
import { ConfigStore } from "./configStore.js";
import { GlobalSettingsStore } from "./globalSettingsStore.js";
import { RuntimeStatus } from "./types.js";

/**
 * Pushes project runtime status snapshots to browser clients.
 *
 * The hub performs one-shot inspections on connect and whenever deployments or
 * runtime actions complete. It deliberately avoids a background polling loop.
 */
export class RuntimeStatusStreamHub {
    private readonly clients = new Set<WebSocket>();
    private readonly statusCache = new Map<string, RuntimeStatus>();

    constructor(
        private readonly configStore: ConfigStore,
        private readonly globalSettingsStore: GlobalSettingsStore,
        private readonly agentManager: AgentManager,
        private readonly adminAuth: AdminAuth,
        private readonly publishRuntimeStatus: (projectId: string | undefined, projectName: string, status: RuntimeStatus) => void = () => {}
    ) {}

    /**
     * Handles HTTP upgrades for `/api/projects/runtime-status/stream`.
     */
    register(server: Server) {
        const webSocketServer = new WebSocketServer({ noServer: true });

        server.on("upgrade", (request, socket, head) => {
            const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
            if (url.pathname !== "/api/projects/runtime-status/stream") {
                return;
            }

            if (!this.adminAuth.isValidToken(url.searchParams.get("token") ?? "")) {
                socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
                socket.destroy();
                return;
            }

            webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
                this.registerClient(webSocket);
            });
        });
    }

    /**
     * Refreshes one project and broadcasts the new status to all subscribers.
     */
    async refreshProject(projectName: string) {
        const project = this.configStore.resolveProject(projectName);
        if (!project) {
            return;
        }

        const status = await this.inspectProject(project.name, project.settings);
        this.statusCache.set(project.settings.id ?? project.name, status);
        this.broadcast({
            type: "runtime-status",
            projectId: project.settings.id,
            projectName: project.name,
            status
        });
        this.publishRuntimeStatus(project.settings.id, project.name, status);
    }

    private registerClient(webSocket: WebSocket) {
        this.clients.add(webSocket);
        const keepAlive = setInterval(() => {
            if (webSocket.readyState === WebSocket.OPEN) {
                webSocket.ping();
            }
        }, 20_000);

        webSocket.on("close", () => {
            clearInterval(keepAlive);
            this.clients.delete(webSocket);
        });

        webSocket.on("error", () => {
            clearInterval(keepAlive);
        });

        void this.sendInitialSnapshot(webSocket);
    }

    private async sendInitialSnapshot(webSocket: WebSocket) {
        const config = this.configStore.readConfig();
        for (const [projectName, appSettings] of Object.entries(config)) {
            if (webSocket.readyState !== WebSocket.OPEN) {
                return;
            }

            const status = await this.inspectProject(projectName, appSettings);
            this.statusCache.set(appSettings.id ?? projectName, status);
            this.send(webSocket, {
                type: "runtime-status",
                projectId: appSettings.id,
                projectName,
                status
            });
        }
    }

    private async inspectProject(projectName: string, appSettings: NonNullable<ReturnType<ConfigStore["resolveProject"]>>["settings"]) {
        try {
            return await this.agentManager.getClient(appSettings.serverId ?? "local").inspectStatus(projectName, appSettings, this.globalSettingsStore.readSettings());
        } catch (error) {
            return {
                status: "error",
                checkedAt: new Date().toISOString(),
                services: [],
                error: error instanceof Error ? error.message : "Could not inspect runtime status."
            } satisfies RuntimeStatus;
        }
    }

    private broadcast(payload: unknown) {
        for (const client of this.clients) {
            this.send(client, payload);
        }
    }

    private send(webSocket: WebSocket, payload: unknown) {
        if (webSocket.readyState === WebSocket.OPEN) {
            webSocket.send(JSON.stringify(payload));
        }
    }
}
