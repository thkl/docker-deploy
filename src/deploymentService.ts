import { DeploymentRecord, DeploymentStore, DeploymentTrigger } from "./deploymentStore.js";
import { defaultProjectPath, GlobalSettingsStore } from "./globalSettingsStore.js";
import { AgentManager } from "./agentManager.js";
import { assertSafeDeletePath } from "./checkoutCleanup.js";
import { GlobalSettings, ProjectSettings } from "./types.js";
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
        private readonly refreshRuntimeStatus: (projectName: string) => void | Promise<void> = () => {},
        private readonly publishDeployment: (projectName: string, deployment: DeploymentRecord | null) => void = () => {},
        private readonly refreshServerHealth: (serverId: string) => void | Promise<void> = () => {}
    ) {}

    /**
     * Creates a deployment record, starts the worker, and wires worker callbacks
     * into persisted deployment history plus WebSocket broadcasts.
     */
    startDeployment(projectName: string, appSettings: ProjectSettings, trigger: DeploymentTrigger) {
        const deployment = this.deploymentStore.start(projectName, trigger, appSettings.serverId ?? "local");
        const globalSettings = this.globalSettingsStore.readSettings();
        this.broadcastDeploymentUpdate(projectName, deployment);
        void this.refreshServerHealth(appSettings.serverId ?? "local");

        const agent = this.agentManager.getClient(appSettings.serverId ?? "local");
        const deploymentRun = agent.deployProject(projectName, appSettings, globalSettings, {
            onOutput: (stream, chunk) => {
                this.deploymentStore.append(projectName, deployment.id, stream, chunk);
                this.broadcastDeploymentUpdate(projectName);
            },
            onSuccess: () => {
                void this.finishSuccessfulDeployment(projectName, deployment.id, appSettings, globalSettings);
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
                this.broadcastDeploymentUpdate(projectName);
                void this.refreshServerHealth(appSettings.serverId ?? "local");
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
            this.broadcastDeploymentUpdate(projectName);
            void this.refreshServerHealth(appSettings.serverId ?? "local");
        });

        return deployment;
    }

    private async finishSuccessfulDeployment(projectName: string, deploymentId: string, appSettings: ProjectSettings, globalSettings: GlobalSettings) {
        if (!this.activeDeployments.has(deploymentId)) {
            return;
        }

        this.activeDeployments.delete(deploymentId);
        await this.cleanupCheckoutAfterDeploy(projectName, deploymentId, appSettings, globalSettings);
        this.deploymentStore.finish(projectName, deploymentId, "succeeded");
        this.broadcastDeploymentUpdate(projectName);
        void this.refreshServerHealth(appSettings.serverId ?? "local");
        void this.refreshRuntimeStatus(projectName);
    }

    private async cleanupCheckoutAfterDeploy(projectName: string, deploymentId: string, appSettings: ProjectSettings, globalSettings: GlobalSettings) {
        await this.cleanupTempDeploymentCheckout(projectName, appSettings, globalSettings, deploymentId);
    }

    private async cleanupTempDeploymentCheckout(projectName: string, appSettings: ProjectSettings, globalSettings: GlobalSettings, deploymentId?: string) {
        if (!globalSettings.cleanupAfterDeploy) {
            return;
        }

        const serverId = appSettings.serverId ?? "local";
        const agent = this.agentManager.getClient(serverId);
        this.logCleanupLine(projectName, deploymentId, "stdout", "--> Cleanup after deploy requested. Verifying temporary checkout bind mounts...");

        try {
            const checkoutPath = assertSafeDeletePath(tempDeployPath(appSettings.path ?? defaultProjectPath(globalSettings, projectName)), globalSettings.dataRoot);
            const bindMountInspection = await agent.inspectCheckoutBindMounts(checkoutPath);
            if (bindMountInspection.references.length > 0) {
                this.logCleanupLine(projectName, deploymentId, "stdout", `--> Cleanup skipped: ${bindMountInspection.references.length} running bind mount(s) still reference the temporary checkout.`);
                for (const reference of bindMountInspection.references.slice(0, 5)) {
                    this.logCleanupLine(projectName, deploymentId, "stdout", `--> Active mount: ${reference.containerName || reference.containerId || "container"} ${reference.source}:${reference.target}`);
                }
                if (bindMountInspection.references.length > 5) {
                    this.logCleanupLine(projectName, deploymentId, "stdout", `--> ${bindMountInspection.references.length - 5} more active temporary-checkout mount(s) omitted.`);
                }
                return;
            }

            const cleanup = await agent.deleteCheckout(checkoutPath);
            for (const step of cleanup.steps) {
                this.logCleanupLine(projectName, deploymentId, "stdout", `--> ${step}`);
            }
            this.logCleanupLine(projectName, deploymentId, "stdout", "--> Cleanup after deploy completed.");
        } catch (error) {
            this.logCleanupLine(projectName, deploymentId, "stderr", `--> Cleanup after deploy skipped: ${readErrorMessage(error)}`);
        }
    }

    private appendDeploymentLine(projectName: string, deploymentId: string, stream: "stdout" | "stderr", message: string) {
        this.deploymentStore.append(projectName, deploymentId, stream, `${message}\n`);
        this.broadcastDeploymentUpdate(projectName);
    }

    private logCleanupLine(projectName: string, deploymentId: string | undefined, stream: "stdout" | "stderr", message: string) {
        if (deploymentId) {
            this.appendDeploymentLine(projectName, deploymentId, stream, message);
            return;
        }

        const line = `[deployment-cleanup] ${projectName}: ${message}`;
        if (stream === "stderr") {
            console.error(line);
        } else {
            console.log(line);
        }
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
        this.broadcastDeploymentUpdate(projectName);
        void this.refreshServerHealth(appSettings.serverId ?? "local");
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
                this.broadcastDeploymentUpdate(deployment.projectName);
                void this.refreshServerHealth(deployment.serverId || "local");
                void this.refreshRuntimeStatus(deployment.projectName);
                continue;
            }

            await this.reconcileDeployment(deployment.projectName, deployment.id, appSettings, globalSettings);
        }

        await this.cleanupStaleTempDeployments(projects, globalSettings);
    }

    /**
     * Removes leftover temp checkouts after controller restarts.
     */
    private async cleanupStaleTempDeployments(projects: Record<string, ProjectSettings>, globalSettings: GlobalSettings) {
        if (!globalSettings.cleanupAfterDeploy) {
            return;
        }

        for (const [projectName, appSettings] of Object.entries(projects)) {
            const latest = this.deploymentStore.latest(appSettings.id ?? projectName);
            if (latest?.status === "running") {
                continue;
            }

            await this.cleanupTempDeploymentCheckout(projectName, appSettings, globalSettings);
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
                await this.cleanupCheckoutAfterDeploy(projectName, deploymentId, appSettings, globalSettings);
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

        this.broadcastDeploymentUpdate(projectName);
        void this.refreshServerHealth(appSettings.serverId ?? "local");
        void this.refreshRuntimeStatus(projectName);
    }

    private broadcastDeploymentUpdate(projectName: string, deployment = this.deploymentStore.latest(projectName)) {
        this.broadcastDeployment(projectName);
        this.publishDeployment(projectName, deployment);
    }
}

function isRuntimeLogStream(value: RuntimeLogStream | Promise<RuntimeLogStream | void> | void): value is RuntimeLogStream {
    return !!value && typeof value === "object" && "stop" in value && typeof value.stop === "function";
}

function readErrorMessage(error: unknown) {
    return error instanceof Error ? error.message : String(error);
}

function tempDeployPath(projectRoot: string) {
    return `${projectRoot.replace(/\/+$/, "")}/.updater/tmpdeploy`;
}
