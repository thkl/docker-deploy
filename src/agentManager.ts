import { AgentClient } from "./agentTypes.js";
import { HttpAgentClient } from "./httpAgentClient.js";
import { ControllerKeyState } from "./keyStore.js";
import { LocalAgent } from "./localAgent.js";
import { ServerStore } from "./serverStore.js";

/**
 * Resolves the correct agent client for a project target server.
 */
export class AgentManager {
    constructor(
        private readonly localAgent: LocalAgent,
        private readonly serverStore: ServerStore,
        private readonly controllerKeys: ControllerKeyState
    ) {}

    /**
     * Returns an in-process local agent or HTTP remote agent.
     */
    getClient(serverId = "local"): AgentClient {
        if (serverId === "local") {
            return this.localAgent;
        }

        const server = this.serverStore.get(serverId);
        if (!server) {
            throw new Error(`Server ${serverId} does not exist.`);
        }

        if (server.kind !== "remote") {
            return this.localAgent;
        }

        return new HttpAgentClient(server, this.controllerKeys);
    }

    /**
     * Picks a known Swarm manager agent, preferring one of the requested target
     * servers when possible.
     */
    findSwarmManagerServerId(preferredServerIds: string[]) {
        const preferred = new Set(preferredServerIds);
        const managers = this.serverStore
            .list()
            .filter((server) => server.status !== "offline" && server.capabilities?.docker.mode === "swarm-manager");

        return managers.find((server) => preferred.has(server.id))?.id ?? managers[0]?.id;
    }
}
