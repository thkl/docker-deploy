import { DeploymentStore, DeploymentTrigger } from "./deploymentStore.js";
import { GlobalSettingsStore } from "./globalSettingsStore.js";
import { AgentManager } from "./agentManager.js";
import { ProjectSettings } from "./types.js";
import { RuntimeLogStream } from "./deploy.js";

/**
 * Coordinates deployment lifecycle state with the worker execution layer.
 *
 * This service is the future controller-to-agent boundary: today it starts the
 * local Docker worker directly, but later it can dispatch the same deployment
 * job to a local or remote agent.
 */
export class DeploymentService {
    private readonly activeDeployments = new Map<string, RuntimeLogStream>();

    constructor(
        private readonly deploymentStore: DeploymentStore,
        private readonly globalSettingsStore: GlobalSettingsStore,
        private readonly agentManager: AgentManager,
        private readonly broadcastDeployment: (projectName: string) => void,
        private readonly refreshRuntimeStatus: (projectName: string) => void | Promise<void> = () => {}
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
        const deploymentRun = agent.deployProject(projectName, appSettings, globalSettings, {
            onOutput: (stream, chunk) => {
                this.deploymentStore.append(projectName, deployment.id, stream, chunk);
                this.broadcastDeployment(projectName);
            },
            onSuccess: () => {
                if (!this.activeDeployments.has(deployment.id)) {
                    return;
                }
                this.activeDeployments.delete(deployment.id);
                this.deploymentStore.finish(projectName, deployment.id, "succeeded");
                this.broadcastDeployment(projectName);
                void this.refreshRuntimeStatus(projectName);
            },
            onFailure: (error) => {
                if (!this.activeDeployments.has(deployment.id)) {
                    return;
                }
                this.activeDeployments.delete(deployment.id);
                this.deploymentStore.finish(projectName, deployment.id, "failed", {
                    error: error.message,
                    exitCode: error.code
                });
                this.broadcastDeployment(projectName);
            }
        });

        if (isRuntimeLogStream(deploymentRun)) {
            this.activeDeployments.set(deployment.id, deploymentRun);
        }

        Promise.resolve(deploymentRun).then((stream) => {
            const latest = this.deploymentStore.latest(appSettings.id ?? projectName);
            if (stream && latest?.id === deployment.id && latest.status === "running") {
                this.activeDeployments.set(deployment.id, stream);
            }
        }).catch((error) => {
            this.activeDeployments.delete(deployment.id);
            this.deploymentStore.finish(projectName, deployment.id, "failed", {
                error: error instanceof Error ? error.message : "Could not dispatch deployment.",
                exitCode: "dispatch"
            });
            this.broadcastDeployment(projectName);
        });

        return deployment;
    }

    /**
     * Cancels the latest active deployment for a project in this controller
     * process and records it as a failed deployment with a canceled exit code.
     */
    cancelDeployment(projectName: string, appSettings: ProjectSettings) {
        const latest = this.deploymentStore.latest(appSettings.id ?? projectName);
        if (latest?.status !== "running") {
            throw new Error("No running deployment exists for this project.");
        }

        const stream = this.activeDeployments.get(latest.id);
        if (!stream) {
            throw new Error("This deployment is not active in the current controller process.");
        }

        this.activeDeployments.delete(latest.id);
        this.deploymentStore.append(projectName, latest.id, "stdout", "--> Deployment canceled by user.\n");
        stream.stop();
        this.deploymentStore.finish(projectName, latest.id, "failed", {
            error: "Deployment canceled by user.",
            exitCode: "canceled"
        });
        this.broadcastDeployment(projectName);
        void this.refreshRuntimeStatus(projectName);
        return this.deploymentStore.latest(appSettings.id ?? projectName);
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
            if (this.activeDeployments.has(deployment.id)) {
                continue;
            }

            const appSettings = projects[deployment.projectName];
            if (!appSettings) {
                this.deploymentStore.finish(deployment.projectName, deployment.id, "failed", {
                    error: "Controller restarted while deployment was running, and the project no longer exists.",
                    exitCode: "controller-restart"
                });
                this.broadcastDeployment(deployment.projectName);
                void this.refreshRuntimeStatus(deployment.projectName);
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
        if (latest?.status !== "running" || this.activeDeployments.has(latest.id)) {
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
        void this.refreshRuntimeStatus(projectName);
    }
}

function isRuntimeLogStream(value: RuntimeLogStream | Promise<RuntimeLogStream | void> | void): value is RuntimeLogStream {
    return !!value && typeof value === "object" && "stop" in value && typeof value.stop === "function";
}
