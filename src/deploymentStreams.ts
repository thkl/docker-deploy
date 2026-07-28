import { Server } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { AdminAuth } from "./auth.js";
import { ConfigStore } from "./configStore.js";
import { DeploymentStore } from "./deploymentStore.js";
import { normalizeProjectName } from "./validation.js";

/**
 * Manages browser WebSocket subscriptions for live deployment status/logs.
 *
 * The hub stores connected clients by project name and broadcasts the latest
 * deployment record whenever the deployment service changes it.
 */
export class DeploymentStreamHub {
    private readonly deploymentClients = new Map<string, Set<WebSocket>>();

    constructor(
        private readonly configStore: ConfigStore,
        private readonly deploymentStore: DeploymentStore,
        private readonly adminAuth: AdminAuth
    ) {}

    /**
     * Handles HTTP upgrade requests for `/api/projects/:name/deployments/stream`.
     */
    register(server: Server) {
        const webSocketServer = new WebSocketServer({ noServer: true });

        server.on("upgrade", (request, socket, head) => {
            const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
            const match = url.pathname.match(/^\/api\/projects\/([^/]+)\/deployments\/stream$/);

            if (!match) {
                socket.destroy();
                return;
            }

            let projectName = "";
            try {
                projectName = normalizeProjectName(decodeURIComponent(match[1]));
            } catch (error) {
                socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
                socket.destroy();
                return;
            }

            if (!this.configStore.fetchProfile(projectName)) {
                socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
                socket.destroy();
                return;
            }

            if (!this.adminAuth.isValidToken(url.searchParams.get("token") ?? "")) {
                socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
                socket.destroy();
                return;
            }

            webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
                this.registerClient(projectName, webSocket);
            });
        });
    }

    /**
     * Sends the newest deployment record to all connected clients for a project.
     */
    broadcast(projectName: string) {
        const clients = this.deploymentClients.get(projectName);
        if (!clients?.size) {
            return;
        }

        const payload = JSON.stringify({
            type: "deployment",
            deployment: this.deploymentStore.latest(projectName)
        });

        for (const client of clients) {
            if (client.readyState === WebSocket.OPEN) {
                client.send(payload);
            }
        }
    }

    /**
     * Registers one browser WebSocket as a project subscriber.
     */
    private registerClient(projectName: string, webSocket: WebSocket) {
        const clients = this.deploymentClients.get(projectName) ?? new Set<WebSocket>();
        clients.add(webSocket);
        this.deploymentClients.set(projectName, clients);

        this.sendSnapshot(projectName, webSocket);

        webSocket.on("close", () => {
            clients.delete(webSocket);
            if (clients.size === 0) {
                this.deploymentClients.delete(projectName);
            }
        });
    }

    /**
     * Sends the current deployment state immediately after a WebSocket connects.
     */
    private sendSnapshot(projectName: string, webSocket: WebSocket) {
        if (webSocket.readyState !== WebSocket.OPEN) {
            return;
        }

        webSocket.send(
            JSON.stringify({
                type: "snapshot",
                deployment: this.deploymentStore.latest(projectName)
            })
        );
    }
}
