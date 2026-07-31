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
    private readonly activeDeploymentIds = new Set<string>();

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
        this.activeDeploymentIds.add(deployment.id);
        this.broadcastDeployment(projectName);

        const agent = this.agentManager.getClient(appSettings.serverId ?? "local");
        Promise.resolve(agent.deployProject(projectName, appSettings, globalSettings, {
            onOutput: (stream, chunk) => {
                this.deploymentStore.append(projectName, deployment.id, stream, chunk);
                this.broadcastDeployment(projectName);
            },
            onSuccess: () => {
                this.activeDeploymentIds.delete(deployment.id);
                this.deploymentStore.finish(projectName, deployment.id, "succeeded");
                this.broadcastDeployment(projectName);
            },
            onFailure: (error) => {
                this.activeDeploymentIds.delete(deployment.id);
                this.deploymentStore.finish(projectName, deployment.id, "failed", {
                    error: error.message,
                    exitCode: error.code
                });
                this.broadcastDeployment(projectName);
            }
        })).catch((error) => {
            this.activeDeploymentIds.delete(deployment.id);
            this.deploymentStore.finish(projectName, deployment.id, "failed", {
                error: error instanceof Error ? error.message : "Could not dispatch deployment.",
                exitCode: "dispatch"
            });
            this.broadcastDeployment(projectName);
        });

        return deployment;
    }

    /**
     * Closes deployments that were left running by a controller restart.
     *
     * This happens during self-updates: the old controller process starts the
     * Docker Compose replacement, then the compose action restarts that same
     * controller before the worker callback can mark the deployment complete.
     */
    async reconcileRunningDeployments(projects: Record<string, ProjectSettings>) {
        const runningDeployments = this.deploymentStore.listRunning();
        if (!runningDeployments.length) {
            return;
        }

        const globalSettings = this.globalSettingsStore.readSettings();
        for (const deployment of runningDeployments) {
            if (this.activeDeploymentIds.has(deployment.id)) {
                continue;
            }

            const appSettings = projects[deployment.projectName];
            if (!appSettings) {
                this.deploymentStore.finish(deployment.projectName, deployment.id, "failed", {
                    error: "Controller restarted while deployment was running, and the project no longer exists.",
                    exitCode: "controller-restart"
                });
                this.broadcastDeployment(deployment.projectName);
                continue;
            }

            await this.reconcileDeployment(deployment.projectName, deployment.id, appSettings, globalSettings);
        }
    }

    /**
     * Reconciles the latest deployment for one project if it is still marked
     * running but this controller no longer has its original worker callbacks.
     */
    async reconcileLatestDeployment(projectName: string, appSettings: ProjectSettings) {
        const latest = this.deploymentStore.latest(appSettings.id ?? projectName);
        if (latest?.status !== "running" || this.activeDeploymentIds.has(latest.id)) {
            return latest;
        }

        await this.reconcileDeployment(projectName, latest.id, appSettings, this.globalSettingsStore.readSettings());
        return this.deploymentStore.latest(appSettings.id ?? projectName);
    }

    private async reconcileDeployment(projectName: string, deploymentId: string, appSettings: ProjectSettings, globalSettings = this.globalSettingsStore.readSettings()) {
        try {
            const status = await this.agentManager.getClient(appSettings.serverId ?? "local").inspectStatus(projectName, appSettings, globalSettings);
            if (status.status === "running" || status.status === "partial") {
                this.deploymentStore.append(
                    projectName,
                    deploymentId,
                    "stdout",
                    `--> Controller restarted before deployment completion was recorded. Runtime status is ${status.status}; marking deployment as succeeded.\n`
                );
                this.deploymentStore.finish(projectName, deploymentId, "succeeded", { exitCode: "controller-restart" });
            } else {
                this.deploymentStore.finish(projectName, deploymentId, "failed", {
                    error: `Controller restarted before deployment completion was recorded. Runtime status is ${status.status}.`,
                    exitCode: "controller-restart"
                });
            }
        } catch (error) {
            this.deploymentStore.finish(projectName, deploymentId, "failed", {
                error: error instanceof Error ? `Controller restarted and runtime reconciliation failed: ${error.message}` : "Controller restarted and runtime reconciliation failed.",
                exitCode: "controller-restart"
            });
        }

        this.broadcastDeployment(projectName);
    }
}
