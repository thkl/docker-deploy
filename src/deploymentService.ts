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
    private readonly serverQueues = new Map<string, Promise<void>>();

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
        const serverIds = this.targetDeploymentServerIds(appSettings);
        const run = this.deploymentStore.startRun(projectName, trigger, serverIds);
        this.broadcastDeploymentUpdate(projectName, run);
        for (const target of run.targets ?? []) {
            this.startDeploymentTarget(projectName, appSettings, target, target.serverId);
        }
        return run;
    }

    private startDeploymentTarget(projectName: string, appSettings: ProjectSettings, deployment: DeploymentRecord, serverId: string) {
        const previous = this.serverQueues.get(serverId) ?? Promise.resolve();
        const queued = previous
            .catch(() => undefined)
            .then(() => this.dispatchDeploymentTarget(projectName, appSettings, deployment, serverId));
        this.serverQueues.set(serverId, queued.finally(() => {
            if (this.serverQueues.get(serverId) === queued) {
                this.serverQueues.delete(serverId);
            }
        }));
    }

    private async dispatchDeploymentTarget(projectName: string, appSettings: ProjectSettings, deployment: DeploymentRecord, serverId: string) {
        const current = this.deploymentStore.get(deployment.id);
        if (current?.status !== "running") {
            return;
        }

        const targetSettings = { ...appSettings, serverId };
        const globalSettings = this.globalSettingsStore.readSettings();
        this.deploymentStore.setPhase(projectName, deployment.id, "dispatching");
        this.broadcastDeploymentUpdate(projectName);
        await this.refreshServerHealth(serverId);

        const agent = this.agentManager.getClient(serverId);
        const deploymentRun = agent.deployProject(projectName, targetSettings, globalSettings, {
            onAccepted: (job) => {
                this.deploymentStore.setAgentJob(projectName, deployment.id, job);
                this.deploymentStore.setPhase(projectName, deployment.id, "running");
                this.broadcastDeploymentUpdate(projectName);
            },
            onOutput: (stream, chunk) => {
                this.deploymentStore.setPhase(projectName, deployment.id, "running");
                this.deploymentStore.append(projectName, deployment.id, stream, chunk);
                this.broadcastDeployment(projectName);
                this.publishDeployment(projectName, this.deploymentStore.latest(projectName));
            },
            onSuccess: () => {
                void this.finishSuccessfulDeployment(projectName, deployment.id, targetSettings, globalSettings);
            },
            onFailure: (error) => {
                const current = this.deploymentStore.get(deployment.id);
                if (current?.status !== "running") {
                    return;
                }
                this.activeDeployments.delete(deployment.id);
                if (error.code === "remote-agent-job-lost") {
                    this.deploymentStore.setPhase(projectName, deployment.id, "reconnecting");
                    this.deploymentStore.append(
                        projectName,
                        deployment.id,
                        "stdout",
                        "--> Remote agent restarted before deployment completion was recorded. Waiting for runtime reconciliation.\n"
                    );
                    this.broadcastDeployment(projectName);
                    void this.reconcileDeployment(
                        projectName,
                        deployment.id,
                        targetSettings,
                        globalSettings,
                        "Remote agent restarted before deployment completion was recorded",
                        "remote-agent-restart"
                    );
                    return;
                }
                this.deploymentStore.finish(projectName, deployment.id, "failed", {
                    error: error.message,
                    exitCode: error.code,
                    phase: "failed"
                });
                this.broadcastDeploymentUpdate(projectName);
                void this.refreshServerHealth(serverId);
            }
        });

        if (isRuntimeLogStream(deploymentRun)) {
            this.activeDeployments.set(deployment.id, deploymentRun);
        }

        Promise.resolve(deploymentRun).then((stream) => {
            const current = this.deploymentStore.get(deployment.id);
            if (stream && current?.status === "running") {
                this.activeDeployments.set(deployment.id, stream);
            }
        }).catch((error) => {
            this.activeDeployments.delete(deployment.id);
            this.deploymentStore.finish(projectName, deployment.id, "failed", {
                error: error instanceof Error ? error.message : "Could not dispatch deployment.",
                exitCode: "dispatch",
                phase: "failed"
            });
            this.broadcastDeploymentUpdate(projectName);
            void this.refreshServerHealth(serverId);
        });

        return;
    }

    private async finishSuccessfulDeployment(projectName: string, deploymentId: string, appSettings: ProjectSettings, globalSettings: GlobalSettings) {
        const current = this.deploymentStore.get(deploymentId);
        if (current?.status !== "running") {
            return;
        }

        this.activeDeployments.delete(deploymentId);
        this.deploymentStore.setPhase(projectName, deploymentId, "cleanup");
        await this.cleanupCheckoutAfterDeploy(projectName, deploymentId, appSettings, globalSettings);
        this.deploymentStore.finish(projectName, deploymentId, "succeeded", { phase: "succeeded" });
        this.broadcastDeploymentUpdate(projectName);
        void this.refreshServerHealth(appSettings.serverId ?? "local");
        void this.refreshRuntimeStatus(projectName);
    }

    private async cleanupCheckoutAfterDeploy(projectName: string, deploymentId: string, appSettings: ProjectSettings, globalSettings: GlobalSettings) {
        await this.cleanupTempDeploymentCheckout(projectName, appSettings, globalSettings, deploymentId);
    }

    private async cleanupTempDeploymentCheckout(projectName: string, appSettings: ProjectSettings, globalSettings: GlobalSettings, deploymentId?: string) {
        if (!globalSettings.cleanupAfterDeploy) {
            this.logCleanupLine(projectName, deploymentId, "stdout", "--> Cleanup after deploy disabled in global settings.");
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
        this.broadcastDeployment(projectName);
        this.publishDeployment(projectName, this.deploymentStore.latest(projectName));
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

        const targets = latest.targets?.length ? latest.targets : [latest];
        if (!targets.some((target) => this.activeDeployments.has(target.id))) {
            throw new Error("This deployment is not active in the current controller process.");
        }

        for (const target of targets) {
            const targetStream = this.activeDeployments.get(target.id);
            if (targetStream) {
                this.activeDeployments.delete(target.id);
                targetStream.stop();
            }
            this.deploymentStore.append(projectName, target.id, "stdout", "--> Deployment canceled by user.\n");
            this.deploymentStore.finish(projectName, target.id, "failed", {
                error: "Deployment canceled by user.",
                exitCode: "canceled",
                phase: "canceled"
            });
        }
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

            const serverId = deployment.serverId || appSettings.serverId || "local";
            const targetSettings = { ...appSettings, serverId };
            if (this.reconnectDeploymentTarget(deployment.projectName, deployment, targetSettings, globalSettings)) {
                continue;
            }

            if (serverId === "local") {
                await this.reconcileDeployment(
                    deployment.projectName,
                    deployment.id,
                    targetSettings,
                    globalSettings,
                    "Controller restarted before local deployment completion was recorded",
                    "controller-restart"
                );
                continue;
            }

            this.deploymentStore.setPhase(deployment.projectName, deployment.id, "reconnecting");
            this.deploymentStore.append(
                deployment.projectName,
                deployment.id,
                "stdout",
                "--> Controller restarted while deployment was running. Waiting for remote job recovery before reconciliation.\n"
            );
            this.broadcastDeploymentUpdate(deployment.projectName);
        }
    }

    /**
     * Removes leftover temp checkouts after controller restarts.
     */
    async cleanupStaleTempDeployments(projects: Record<string, ProjectSettings>, globalSettings = this.globalSettingsStore.readSettings()) {
        if (!globalSettings.cleanupAfterDeploy) {
            return;
        }

        for (const [projectName, appSettings] of Object.entries(projects)) {
            const latest = this.deploymentStore.latest(appSettings.id ?? projectName);
            if (latest?.status === "running") {
                continue;
            }

            for (const serverId of targetServerIds(appSettings)) {
                await this.cleanupTempDeploymentCheckout(projectName, { ...appSettings, serverId }, globalSettings);
            }
        }
    }

    /**
     * Reconciles the latest deployment for one project if it is still marked
     * running but this controller no longer has its original worker callbacks.
     */
    async reconcileLatestDeployment(projectName: string, appSettings: ProjectSettings) {
        const latest = this.deploymentStore.latest(appSettings.id ?? projectName);
        if (latest?.status !== "running") {
            return latest;
        }

        const targets = latest.targets?.length ? latest.targets : [latest];
        const globalSettings = this.globalSettingsStore.readSettings();
        for (const target of targets) {
            if (target.status !== "running" || this.activeDeployments.has(target.id)) {
                continue;
            }
            const serverId = target.serverId || appSettings.serverId || "local";
            const targetSettings = { ...appSettings, serverId };
            if (this.reconnectDeploymentTarget(projectName, target, targetSettings, globalSettings)) {
                continue;
            }
            if (serverId === "local") {
                await this.reconcileDeployment(
                    projectName,
                    target.id,
                    targetSettings,
                    globalSettings,
                    "Controller restarted before local deployment completion was recorded",
                    "controller-restart"
                );
                continue;
            }
            this.deploymentStore.setPhase(projectName, target.id, "reconnecting");
        }
        return this.deploymentStore.latest(appSettings.id ?? projectName);
    }

    private reconnectDeploymentTarget(projectName: string, deployment: DeploymentRecord, appSettings: ProjectSettings, globalSettings: GlobalSettings) {
        if (!deployment.agentJobId || !deployment.agentStreamToken) {
            return false;
        }

        const agent = this.agentManager.getClient(appSettings.serverId ?? deployment.serverId ?? "local");
        if (!("reconnectDeploymentLog" in agent) || typeof agent.reconnectDeploymentLog !== "function") {
            return false;
        }

        this.deploymentStore.setPhase(projectName, deployment.id, "reconnecting");
        this.broadcastDeployment(projectName);
        const stream = agent.reconnectDeploymentLog(deployment.agentJobId, deployment.agentStreamToken, this.deploymentHooks(projectName, deployment.id, appSettings, globalSettings));
        this.activeDeployments.set(deployment.id, stream);
        return true;
    }

    private deploymentHooks(projectName: string, deploymentId: string, appSettings: ProjectSettings, globalSettings: GlobalSettings) {
        return {
            onOutput: (stream: "stdout" | "stderr", chunk: string) => {
                this.deploymentStore.setPhase(projectName, deploymentId, "running");
                this.deploymentStore.append(projectName, deploymentId, stream, chunk);
                this.broadcastDeployment(projectName);
                this.publishDeployment(projectName, this.deploymentStore.latest(projectName));
            },
            onSuccess: () => {
                void this.finishSuccessfulDeployment(projectName, deploymentId, appSettings, globalSettings);
            },
            onFailure: (error: Error & { code?: number | string }) => {
                const current = this.deploymentStore.get(deploymentId);
                if (current?.status !== "running") {
                    return;
                }
                this.activeDeployments.delete(deploymentId);
                if (error.code === "remote-agent-job-lost") {
                    this.deploymentStore.setPhase(projectName, deploymentId, "reconnecting");
                    this.deploymentStore.append(projectName, deploymentId, "stdout", "--> Remote job stream is unavailable. Keeping target in reconnecting state.\n");
                    this.broadcastDeploymentUpdate(projectName);
                    return;
                }
                this.deploymentStore.finish(projectName, deploymentId, "failed", {
                    error: error.message,
                    exitCode: error.code,
                    phase: "failed"
                });
                this.broadcastDeploymentUpdate(projectName);
            }
        };
    }

    private async reconcileDeployment(
        projectName: string,
        deploymentId: string,
        appSettings: ProjectSettings,
        globalSettings = this.globalSettingsStore.readSettings(),
        reason = "Controller restarted before deployment completion was recorded",
        exitCode = "controller-restart"
    ) {
        try {
            await delay(5000);
            this.deploymentStore.setPhase(projectName, deploymentId, "reconciling");
            this.broadcastDeployment(projectName);
            const status = await this.agentManager.getClient(appSettings.serverId ?? "local").inspectStatus(projectName, appSettings, globalSettings);
            if (status.status === "running" || status.status === "partial") {
                this.deploymentStore.append(
                    projectName,
                    deploymentId,
                    "stdout",
                    `--> ${reason}. Runtime status is ${status.status}; marking deployment as succeeded.\n`
                );
                await this.cleanupCheckoutAfterDeploy(projectName, deploymentId, appSettings, globalSettings);
                this.deploymentStore.finish(projectName, deploymentId, "succeeded", { exitCode });
            } else {
                this.deploymentStore.finish(projectName, deploymentId, "failed", {
                    error: `${reason}. Runtime status is ${status.status}.`,
                    exitCode
                });
            }
        } catch (error) {
            this.deploymentStore.finish(projectName, deploymentId, "failed", {
                error: error instanceof Error ? `${reason}, and runtime reconciliation failed: ${error.message}` : `${reason}, and runtime reconciliation failed.`,
                exitCode
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

    private targetDeploymentServerIds(appSettings: ProjectSettings) {
        const ids = targetServerIds(appSettings);
        if (appSettings.deploymentStrategy !== "swarm") {
            return ids;
        }

        const managerId = this.agentManager.findSwarmManagerServerId(ids);
        return [managerId ?? ids[0] ?? "local"];
    }
}

function targetServerIds(appSettings: ProjectSettings) {
    const ids = (appSettings.serverIds?.length ? appSettings.serverIds : [appSettings.serverId ?? "local"])
        .map((serverId) => serverId.trim())
        .filter(Boolean);
    return [...new Set(ids.length ? ids : ["local"])];
}

function delay(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
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
