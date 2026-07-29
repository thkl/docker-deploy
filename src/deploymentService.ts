import { DeploymentStore, DeploymentTrigger } from "./deploymentStore.js";
import { GlobalSettingsStore } from "./globalSettingsStore.js";
import { AgentManager } from "./agentManager.js";
import { ProjectSettings } from "./types.js";

/**
 * Coordinates deployment lifecycle state with the worker execution layer.
 *
 * This service is the future controller-to-agent boundary: today it starts the
 * local Docker worker directly, but later it can dispatch the same deployment
 * job to a local or remote agent.
 */
export class DeploymentService {
    constructor(
        private readonly deploymentStore: DeploymentStore,
        private readonly globalSettingsStore: GlobalSettingsStore,
        private readonly agentManager: AgentManager,
        private readonly broadcastDeployment: (projectName: string) => void
    ) {}

    /**
     * Creates a deployment record, starts the worker, and wires worker callbacks
     * into persisted deployment history plus WebSocket broadcasts.
     */
    startDeployment(projectName: string, appSettings: ProjectSettings, trigger: DeploymentTrigger) {
        const deployment = this.deploymentStore.start(projectName, trigger, appSettings.serverId ?? "local");
        const globalSettings = this.globalSettingsStore.readSettings();
        this.broadcastDeployment(projectName);

        const agent = this.agentManager.getClient(appSettings.serverId ?? "local");
        Promise.resolve(agent.deployProject(projectName, appSettings, globalSettings, {
            onOutput: (stream, chunk) => {
                this.deploymentStore.append(projectName, deployment.id, stream, chunk);
                this.broadcastDeployment(projectName);
            },
            onSuccess: () => {
                this.deploymentStore.finish(projectName, deployment.id, "succeeded");
                this.broadcastDeployment(projectName);
            },
            onFailure: (error) => {
                this.deploymentStore.finish(projectName, deployment.id, "failed", {
                    error: error.message,
                    exitCode: error.code
                });
                this.broadcastDeployment(projectName);
            }
        })).catch((error) => {
            this.deploymentStore.finish(projectName, deployment.id, "failed", {
                error: error instanceof Error ? error.message : "Could not dispatch deployment.",
                exitCode: "dispatch"
            });
            this.broadcastDeployment(projectName);
        });

        return deployment;
    }
}
