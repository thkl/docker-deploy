import { Server } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { AdminAuth } from "./auth.js";
import { DeploymentRecord } from "./deploymentStore.js";
import { NotificationDeliveryRecord } from "./types.js";
import { RuntimeOperationRecord } from "./runtimeOperationStore.js";
import { RuntimeStatus, ServerRecord } from "./types.js";

export type ControllerEvent =
    | { type: "connected"; connectedAt: string }
    | { type: "projects.updated"; changedAt: string }
    | { type: "servers.updated"; changedAt: string }
    | { type: "server.health"; server: ServerRecord }
    | { type: "deployment.updated"; projectId?: string; projectName: string; deployment: DeploymentRecord | null }
    | { type: "notification.sent"; notification: NotificationDeliveryRecord }
    | { type: "runtime.status"; projectId?: string; projectName: string; status: RuntimeStatus }
    | { type: "runtime.operation.updated"; projectId?: string; projectName: string; operation: RuntimeOperationRecord };

/**
 * Global browser event stream for controller-wide live updates.
 */
export class EventBus {
    private readonly clients = new Set<WebSocket>();
    private readonly subscribers = new Set<(event: ControllerEvent) => void | Promise<void>>();

    constructor(
        private readonly adminAuth: AdminAuth,
        private readonly snapshotProvider: () => ControllerEvent[] | Promise<ControllerEvent[]> = () => []
    ) {}

    /**
     * Handles HTTP upgrades for `/api/events/stream`.
     */
    register(server: Server) {
        const webSocketServer = new WebSocketServer({ noServer: true });

        server.on("upgrade", (request, socket, head) => {
            const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
            if (url.pathname !== "/api/events/stream") {
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

    publish(event: ControllerEvent) {
        for (const client of this.clients) {
            this.send(client, event);
        }
        for (const subscriber of this.subscribers) {
            Promise.resolve(subscriber(event)).catch((error) => {
                console.warn(`[event-bus] subscriber failed: ${error instanceof Error ? error.message : String(error)}`);
            });
        }
    }

    subscribe(subscriber: (event: ControllerEvent) => void | Promise<void>) {
        this.subscribers.add(subscriber);
        return () => this.subscribers.delete(subscriber);
    }

    private registerClient(webSocket: WebSocket) {
        this.clients.add(webSocket);
        const keepAlive = setInterval(() => {
            if (webSocket.readyState === WebSocket.OPEN) {
                webSocket.ping();
            }
        }, 20_000);

        this.send(webSocket, { type: "connected", connectedAt: new Date().toISOString() });
        void this.sendInitialSnapshot(webSocket);

        webSocket.on("close", () => {
            clearInterval(keepAlive);
            this.clients.delete(webSocket);
        });

        webSocket.on("error", () => {
            clearInterval(keepAlive);
        });
    }

    private send(webSocket: WebSocket, event: ControllerEvent) {
        if (webSocket.readyState === WebSocket.OPEN) {
            webSocket.send(JSON.stringify(event));
        }
    }

    private async sendInitialSnapshot(webSocket: WebSocket) {
        const events = await this.snapshotProvider();
        for (const event of events) {
            if (webSocket.readyState !== WebSocket.OPEN) {
                return;
            }

            this.send(webSocket, event);
        }
    }
}
