import { AgentManager } from "./agentManager.js";
import { DeploymentStore } from "./deploymentStore.js";
import { GlobalSettingsStore } from "./globalSettingsStore.js";
import { ServerStore } from "./serverStore.js";
import { GlobalSettings, ServerActiveJob, ServerCapabilities, ServerRecord } from "./types.js";
import { appVersion } from "./version.js";

const heartbeatIntervalMs = 5 * 60 * 1000;

export interface AgentHealthBody {
    serverId?: string;
    paired?: boolean;
    version?: string;
    activeJobs?: ServerActiveJob[];
    encryptionPublicKey?: string;
    signingPublicKey?: string;
    capabilities?: ServerCapabilities;
}

/**
 * Refreshes and persists agent health snapshots for the controller.
 */
export class AgentHealthService {
    private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
    private heartbeatRunning = false;

    constructor(
        private readonly serverStore: ServerStore,
        private readonly deploymentStore: DeploymentStore,
        private readonly globalSettingsStore: GlobalSettingsStore,
        private readonly agentManager: AgentManager
    ) {}

    /**
     * Starts the five-minute remote agent heartbeat loop.
     */
    startHeartbeat() {
        if (this.heartbeatTimer) {
            return;
        }

        void this.refreshAllRemoteAgents();
        this.heartbeatTimer = setInterval(() => {
            void this.refreshAllRemoteAgents();
        }, heartbeatIntervalMs);
    }

    /**
     * Refreshes the locally embedded agent health row.
     */
    refreshLocal() {
        const capabilities = this.serverStore.get("local")?.capabilities;
        return this.serverStore.updateHealth("local", {
            status: "online",
            agentVersion: appVersion(),
            activeJobs: this.localActiveJobs(),
            capabilities: capabilities ?? {
                traefik: {
                    available: false,
                    containerCount: 0,
                    networkPresent: false,
                    checkedAt: new Date().toISOString()
                }
            }
        });
    }

    /**
     * Refreshes one server, local or remote.
     */
    async refreshServer(serverId: string) {
        const server = this.serverStore.get(serverId);
        if (!server) {
            throw new Error("Server does not exist.");
        }

        if (server.kind === "local") {
            return this.refreshLocal();
        }

        return this.refreshRemote(server);
    }

    /**
     * Refreshes all configured remote agents once.
     */
    async refreshAllRemoteAgents() {
        if (this.heartbeatRunning) {
            return;
        }

        this.heartbeatRunning = true;
        try {
            await Promise.all(this.serverStore.list().filter((server) => server.kind === "remote").map((server) => this.refreshRemote(server)));
        } finally {
            this.heartbeatRunning = false;
        }
    }

    /**
     * Fetches one remote agent health endpoint without persisting it.
     */
    async fetchAgentHealth(agentBaseUrl: string) {
        return fetchAgentHealth(agentBaseUrl, this.globalSettingsStore.readSettings());
    }

    private async refreshRemote(server: ServerRecord) {
        if (!server.baseUrl) {
            return this.serverStore.updateHealth(server.id, {
                status: server.status === "unpaired" ? "unpaired" : "offline",
                activeJobs: [],
                lastHealthError: "Remote agent URL is missing."
            });
        }

        const health = await fetchAgentHealth(server.baseUrl, this.globalSettingsStore.readSettings());
        if (!health.ok || !health.body) {
            return this.serverStore.updateHealth(server.id, {
                status: server.status === "unpaired" ? "unpaired" : "offline",
                activeJobs: [],
                lastHealthError: health.message
            });
        }

        return this.serverStore.updateHealth(server.id, {
            status: health.body.paired ? "online" : "unpaired",
            agentVersion: health.body.version,
            activeJobs: health.body.activeJobs ?? [],
            capabilities: health.body.capabilities
        });
    }

    private localActiveJobs() {
        return this.deploymentStore
            .listRunning()
            .filter((deployment) => (deployment.serverId || "local") === "local")
            .map((deployment) => ({
                id: deployment.id,
                type: `deploy:${deployment.trigger}`,
                startedAt: deployment.startedAt
            }));
    }
}

/**
 * Checks that a URL points to the updater agent API.
 */
export async function fetchAgentHealth(agentBaseUrl: string, globalSettings: GlobalSettings) {
    if (!agentBaseUrl) {
        return { ok: false, message: "Agent URL is required." };
    }

    const healthUrl = `${agentBaseUrl.replace(/\/+$/, "")}/agent/health?traefikNetwork=${encodeURIComponent(globalSettings.defaultTraefikNetwork)}`;
    try {
        const response = await fetch(healthUrl);
        if (!response.ok) {
            return {
                ok: false,
                message: `${healthUrl} returned HTTP ${response.status}. Configure the proxy/port so this URL reaches the agent container.`
            };
        }

        const body = await response.json() as AgentHealthBody;
        if (!body.serverId || !body.encryptionPublicKey || !body.signingPublicKey) {
            return {
                ok: false,
                message: `${healthUrl} answered, but it did not look like an updater agent.`
            };
        }

        return { ok: true, message: "", body };
    } catch (error) {
        return {
            ok: false,
            message: `${healthUrl} could not be reached: ${error instanceof Error ? error.message : String(error)}`
        };
    }
}
