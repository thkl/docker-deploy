import { DeploymentRecord, DeploymentStore, DeploymentTrigger } from "./deploymentStore.js";
import { defaultProjectPath, GlobalSettingsStore } from "./globalSettingsStore.js";
import { AgentManager } from "./agentManager.js";
import { assertSafeDeletePath } from "./checkoutCleanup.js";
import { GlobalSettings, ProjectSettings } from "./types.js";
import { RuntimeLogStream } from "./deploy.js";
import { ReleaseStore } from "./releaseStore.js";
import { VaultSecretStore } from "./vaultSecretStore.js";
import { fetchInfisicalSecrets, infisicalSecretReferenceKey } from "./infisicalSecrets.js";

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
    private readonly scheduledDeploymentTargets = new Set<string>();

    constructor(
        private readonly deploymentStore: DeploymentStore,
        private readonly releaseStore: ReleaseStore,
        private readonly globalSettingsStore: GlobalSettingsStore,
        private readonly vaultSecretStore: VaultSecretStore,
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
        const configuredServerIds = this.targetDeploymentServerIds(appSettings);
        const masterServerId = this.registryFanoutMasterServerId(appSettings, configuredServerIds);
        const serverIds = masterServerId
            ? [masterServerId, ...configuredServerIds.filter((serverId) => serverId !== masterServerId)]
            : configuredServerIds;
        const run = this.deploymentStore.startRun(projectName, trigger, serverIds, masterServerId ?? undefined);
        this.broadcastDeploymentUpdate(projectName, run);
        const targets = run.targets ?? [];
        const masterTarget = masterServerId ? targets.find((target) => target.serverId === masterServerId) : undefined;
        if (masterTarget) {
            this.startDeploymentTarget(projectName, appSettings, masterTarget, masterTarget.serverId);
        } else {
            for (const target of targets) {
                this.startDeploymentTarget(projectName, appSettings, target, target.serverId);
            }
        }
        return run;
    }

    /**
     * Starts a rollback deployment from a captured release snapshot.
     */
    rollbackRelease(projectName: string, appSettings: ProjectSettings, releaseId: string) {
        const release = this.releaseStore.get(appSettings.id ?? projectName, releaseId);
        if (!release) {
            throw new Error("Release snapshot does not exist.");
        }
        if (!release.rollbackAvailable) {
            throw new Error(release.rollbackUnavailableReason || "This release snapshot cannot be rolled back safely.");
        }

        const run = this.deploymentStore.startRun(projectName, "rollback", [release.serverId]);
        this.broadcastDeploymentUpdate(projectName, run);
        const target = run.targets?.[0];
        if (target) {
            this.startRollbackTarget(projectName, appSettings, release, target, release.serverId);
        }
        return run;
    }

    private startDeploymentTarget(
        projectName: string,
        appSettings: ProjectSettings,
        deployment: DeploymentRecord,
        serverId: string,
        releaseSnapshot?: NonNullable<ReturnType<ReleaseStore["get"]>>
    ) {
        if (this.scheduledDeploymentTargets.has(deployment.id) || this.activeDeployments.has(deployment.id)) {
            return;
        }
        this.scheduledDeploymentTargets.add(deployment.id);
        const previous = this.serverQueues.get(serverId) ?? Promise.resolve();
        const queued = previous
            .catch(() => undefined)
            .then(() => releaseSnapshot
                ? this.dispatchRegistrySnapshotReplica(projectName, appSettings, deployment, serverId, releaseSnapshot)
                : this.dispatchDeploymentTarget(projectName, appSettings, deployment, serverId))
            .catch((error) => {
                const current = this.deploymentStore.get(deployment.id);
                if (current?.status !== "running") return;
                this.deploymentStore.finish(projectName, deployment.id, "failed", {
                    error: readErrorMessage(error),
                    exitCode: "dispatch",
                    phase: "failed"
                });
                this.scheduledDeploymentTargets.delete(deployment.id);
                this.broadcastDeploymentUpdate(projectName);
                this.failQueuedRegistryReplicas(projectName, deployment, appSettings, "The primary target could not start deployment.");
            });
        const settled = queued.finally(() => {
            if (this.serverQueues.get(serverId) === settled) {
                this.serverQueues.delete(serverId);
            }
        });
        this.serverQueues.set(serverId, settled);
    }

    private async dispatchDeploymentTarget(projectName: string, appSettings: ProjectSettings, deployment: DeploymentRecord, serverId: string) {
        const current = this.deploymentStore.get(deployment.id);
        if (current?.status !== "running") {
            this.scheduledDeploymentTargets.delete(deployment.id);
            return;
        }

        let targetSettings: ProjectSettings;
        try {
            targetSettings = await this.resolveDeploymentSecrets(this.registryTargetSettings(appSettings, deployment, serverId));
        } catch (error) {
            this.deploymentStore.finish(projectName, deployment.id, "failed", {
                error: error instanceof Error ? error.message : "Could not resolve deployment secrets.",
                exitCode: "secret-resolution",
                phase: "failed"
            });
            this.broadcastDeploymentUpdate(projectName);
            this.scheduledDeploymentTargets.delete(deployment.id);
            this.failQueuedRegistryReplicas(projectName, deployment, appSettings, "The primary target could not prepare deployment secrets.");
            return;
        }
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
                this.handleSuccessfulDeployment(projectName, deployment, targetSettings, globalSettings);
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
                this.scheduledDeploymentTargets.delete(deployment.id);
                this.broadcastDeploymentUpdate(projectName);
                void this.refreshServerHealth(serverId);
                this.failQueuedRegistryReplicas(projectName, deployment, appSettings, "The primary target failed before publishing the registry image.");
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
            this.scheduledDeploymentTargets.delete(deployment.id);
            this.broadcastDeploymentUpdate(projectName);
            void this.refreshServerHealth(serverId);
            this.failQueuedRegistryReplicas(projectName, deployment, appSettings, "The primary target could not start the registry image deployment.");
        });

        return;
    }

    private async dispatchRegistrySnapshotReplica(
        projectName: string,
        appSettings: ProjectSettings,
        deployment: DeploymentRecord,
        serverId: string,
        release: NonNullable<ReturnType<ReleaseStore["get"]>>
    ) {
        const current = this.deploymentStore.get(deployment.id);
        if (current?.status !== "running") {
            this.scheduledDeploymentTargets.delete(deployment.id);
            return;
        }

        let targetSettings: ProjectSettings;
        try {
            targetSettings = await this.resolveDeploymentSecrets(this.registryTargetSettings(appSettings, deployment, serverId));
        } catch (error) {
            this.deploymentStore.finish(projectName, deployment.id, "failed", {
                error: error instanceof Error ? error.message : "Could not resolve deployment secrets.",
                exitCode: "secret-resolution",
                phase: "failed"
            });
            this.scheduledDeploymentTargets.delete(deployment.id);
            this.broadcastDeploymentUpdate(projectName);
            return;
        }

        const globalSettings = this.globalSettingsStore.readSettings();
        const targetRelease = {
            ...release,
            serverId,
            projectPath: targetSettings.path ?? defaultProjectPath(globalSettings, projectName)
        };
        this.deploymentStore.setPhase(projectName, deployment.id, "dispatching");
        this.broadcastDeploymentUpdate(projectName);
        await this.refreshServerHealth(serverId);

        const agent = this.agentManager.getClient(serverId);
        const deploymentRun = agent.deployReleaseSnapshot(targetRelease, globalSettings, {
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
            onSuccess: () => this.handleSuccessfulDeployment(projectName, deployment, targetSettings, globalSettings),
            onFailure: (error) => {
                const latest = this.deploymentStore.get(deployment.id);
                if (latest?.status !== "running") return;
                this.activeDeployments.delete(deployment.id);
                if (error.code === "remote-agent-job-lost") {
                    this.deploymentStore.setPhase(projectName, deployment.id, "reconnecting");
                    this.deploymentStore.append(projectName, deployment.id, "stdout", "--> Remote agent restarted before registry image deployment was recorded. Waiting for runtime reconciliation.\n");
                    this.broadcastDeploymentUpdate(projectName);
                    void this.reconcileDeployment(projectName, deployment.id, targetSettings, globalSettings, "Remote agent restarted before registry image deployment was recorded", "remote-agent-restart");
                    return;
                }
                this.deploymentStore.finish(projectName, deployment.id, "failed", {
                    error: error.message,
                    exitCode: error.code,
                    phase: "failed"
                });
                this.scheduledDeploymentTargets.delete(deployment.id);
                this.broadcastDeploymentUpdate(projectName);
                void this.refreshServerHealth(serverId);
            }
        }, { appSettings: targetSettings, requireRegistryPull: true });

        if (isRuntimeLogStream(deploymentRun)) {
            this.activeDeployments.set(deployment.id, deploymentRun);
        }
        Promise.resolve(deploymentRun).then((stream) => {
            const latest = this.deploymentStore.get(deployment.id);
            if (stream && latest?.status === "running") this.activeDeployments.set(deployment.id, stream);
        }).catch((error) => {
            this.activeDeployments.delete(deployment.id);
            this.deploymentStore.finish(projectName, deployment.id, "failed", {
                error: readErrorMessage(error),
                exitCode: "dispatch",
                phase: "failed"
            });
            this.scheduledDeploymentTargets.delete(deployment.id);
            this.broadcastDeploymentUpdate(projectName);
            void this.refreshServerHealth(serverId);
        });
    }

    private startRollbackTarget(projectName: string, appSettings: ProjectSettings, release: NonNullable<ReturnType<ReleaseStore["get"]>>, deployment: DeploymentRecord, serverId: string) {
        const previous = this.serverQueues.get(serverId) ?? Promise.resolve();
        const queued = previous
            .catch(() => undefined)
            .then(() => this.dispatchRollbackTarget(projectName, appSettings, release, deployment, serverId));
        this.serverQueues.set(serverId, queued.finally(() => {
            if (this.serverQueues.get(serverId) === queued) {
                this.serverQueues.delete(serverId);
            }
        }));
    }

    private async dispatchRollbackTarget(projectName: string, appSettings: ProjectSettings, release: NonNullable<ReturnType<ReleaseStore["get"]>>, deployment: DeploymentRecord, serverId: string) {
        const current = this.deploymentStore.get(deployment.id);
        if (current?.status !== "running") {
            return;
        }

        let targetSettings: ProjectSettings;
        try {
            targetSettings = await this.resolveDeploymentSecrets({ ...appSettings, serverId });
        } catch (error) {
            this.deploymentStore.finish(projectName, deployment.id, "failed", {
                error: error instanceof Error ? error.message : "Could not resolve rollback secrets.",
                exitCode: "secret-resolution",
                phase: "failed"
            });
            this.broadcastDeploymentUpdate(projectName);
            return;
        }
        const globalSettings = this.globalSettingsStore.readSettings();
        this.deploymentStore.setPhase(projectName, deployment.id, "dispatching");
        this.deploymentStore.append(projectName, deployment.id, "stdout", `--> Rolling back to release ${release.id} from ${release.createdAt}.\n`);
        this.broadcastDeploymentUpdate(projectName);
        await this.refreshServerHealth(serverId);

        const agent = this.agentManager.getClient(serverId);
        const deploymentRun = agent.deployReleaseSnapshot(release, globalSettings, {
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
                this.deploymentStore.finish(projectName, deployment.id, "failed", {
                    error: error.message,
                    exitCode: error.code,
                    phase: "failed"
                });
                this.broadcastDeploymentUpdate(projectName);
                void this.refreshServerHealth(serverId);
            }
        }, { appSettings: targetSettings });

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
                error: error instanceof Error ? error.message : "Could not dispatch rollback.",
                exitCode: "dispatch",
                phase: "failed"
            });
            this.broadcastDeploymentUpdate(projectName);
            void this.refreshServerHealth(serverId);
        });
    }

    private async finishSuccessfulDeployment(projectName: string, deploymentId: string, appSettings: ProjectSettings, globalSettings: GlobalSettings) {
        const current = this.deploymentStore.get(deploymentId);
        if (current?.status !== "running") {
            return undefined;
        }

        this.activeDeployments.delete(deploymentId);
        this.deploymentStore.setPhase(projectName, deploymentId, "cleanup");
        const release = await this.captureReleaseSnapshot(projectName, deploymentId, appSettings, globalSettings);
        await this.cleanupCheckoutAfterDeploy(projectName, deploymentId, appSettings, globalSettings);
        this.deploymentStore.finish(projectName, deploymentId, "succeeded", { phase: "succeeded" });
        this.broadcastDeploymentUpdate(projectName);
        void this.refreshServerHealth(appSettings.serverId ?? "local");
        void this.refreshRuntimeStatus(projectName);
        return release;
    }

    private handleSuccessfulDeployment(projectName: string, deployment: DeploymentRecord, appSettings: ProjectSettings, globalSettings: GlobalSettings) {
        void this.finishSuccessfulDeployment(projectName, deployment.id, appSettings, globalSettings).then((release) => {
            this.scheduledDeploymentTargets.delete(deployment.id);
            this.startQueuedRegistryReplicas(projectName, deployment, appSettings, release);
        }).catch((error) => {
            this.scheduledDeploymentTargets.delete(deployment.id);
            const current = this.deploymentStore.get(deployment.id);
            if (current?.status === "running") {
                this.deploymentStore.finish(projectName, deployment.id, "failed", {
                    error: readErrorMessage(error),
                    exitCode: "deployment-finalization",
                    phase: "failed"
                });
            }
            this.broadcastDeploymentUpdate(projectName);
            this.failQueuedRegistryReplicas(projectName, deployment, appSettings, "The primary target could not finish before replica deployment.");
        });
    }

    private startQueuedRegistryReplicas(
        projectName: string,
        masterDeployment: DeploymentRecord,
        appSettings: ProjectSettings,
        release?: NonNullable<ReturnType<ReleaseStore["get"]>>
    ) {
        const run = masterDeployment.runId ? this.deploymentStore.getRun(masterDeployment.runId) : null;
        if (!run?.masterServerId || !run.targets?.length) {
            return;
        }
        const masterServerId = run.masterServerId;
        const masterTarget = run.targets.find((target) => target.serverId === masterServerId);
        if (!masterTarget || masterTarget.serverId !== masterDeployment.serverId || masterTarget.status !== "succeeded") {
            return;
        }

        for (const target of run.targets.filter((target) => target.serverId !== masterServerId)) {
            if (target.status !== "running") continue;
            this.appendDeploymentLine(projectName, target.id, "stdout", `--> Primary target ${masterDeployment.serverId} published the image; pulling the shared registry image now.`);
            const reusableSnapshot = release && !release.sourceCheckoutRequired && release.buildServices.length === 0 ? release : undefined;
            this.startDeploymentTarget(projectName, appSettings, target, target.serverId, reusableSnapshot);
        }
    }

    private failQueuedRegistryReplicas(projectName: string, deployment: DeploymentRecord, appSettings: ProjectSettings, reason: string) {
        const run = deployment.runId ? this.deploymentStore.getRun(deployment.runId) : null;
        if (!run?.masterServerId || !run.targets?.length) {
            return;
        }
        const masterServerId = run.masterServerId;
        if (masterServerId !== deployment.serverId) return;

        for (const target of run.targets.filter((candidate) => candidate.serverId !== masterServerId)) {
            if (target.status !== "running" || target.phase !== "queued") continue;
            const message = `Replica deployment was not started because primary target ${deployment.serverId} failed. ${reason}`;
            this.appendDeploymentLine(projectName, target.id, "stderr", `--> ${message}`);
            this.deploymentStore.finish(projectName, target.id, "failed", {
                error: message,
                exitCode: "registry-master-failed",
                phase: "failed"
            });
        }
        this.broadcastDeploymentUpdate(projectName);
    }

    private registryFanoutMasterServerId(appSettings: ProjectSettings, serverIds: string[]) {
        if (!this.registryFanoutEnabled(appSettings, serverIds)) {
            return null;
        }
        const primaryServerId = appSettings.serverId?.trim();
        return primaryServerId && serverIds.includes(primaryServerId) ? primaryServerId : serverIds[0] ?? null;
    }

    private registryFanoutEnabled(appSettings: ProjectSettings, serverIds: string[]) {
        return appSettings.deploymentStrategy !== "swarm"
            && serverIds.length > 1
            && Boolean(appSettings.registry?.publish)
            && Boolean(appSettings.registry?.deployFromRegistry);
    }

    private registryTargetSettings(appSettings: ProjectSettings, deployment: DeploymentRecord, serverId: string): ProjectSettings {
        const run = deployment.runId ? this.deploymentStore.getRun(deployment.runId) : null;
        const masterServerId = run?.masterServerId;
        const isReplica = Boolean(masterServerId) && masterServerId !== serverId;
        if (!isReplica) {
            return { ...appSettings, serverId };
        }

        return {
            ...appSettings,
            serverId,
            registry: {
                ...appSettings.registry,
                publish: false,
                deployFromRegistry: true
            }
        };
    }

    private reconcileQueuedRegistryReplica(projectName: string, deployment: DeploymentRecord, appSettings: ProjectSettings) {
        const run = deployment.runId ? this.deploymentStore.getRun(deployment.runId) : null;
        if (!run?.masterServerId || !run.targets?.length) return false;
        const masterServerId = run.masterServerId;
        const master = run.targets.find((target) => target.serverId === masterServerId);
        if (!master) return false;
        if (deployment.serverId === master.serverId) return false;

        if (master.status === "failed") {
            this.failQueuedRegistryReplicas(projectName, master, appSettings, "The primary build/publish target failed.");
            return true;
        }
        if (master.status !== "succeeded") {
            return true;
        }
        if (deployment.phase === "queued" && !deployment.agentJobId) {
            this.appendDeploymentLine(projectName, deployment.id, "stdout", `--> Primary target ${master.serverId} has published the registry image; starting this replica.`);
            this.startDeploymentTarget(projectName, appSettings, deployment, deployment.serverId);
            return true;
        }
        return false;
    }

    private async captureReleaseSnapshot(projectName: string, deploymentId: string, appSettings: ProjectSettings, globalSettings: GlobalSettings) {
        const deployment = this.deploymentStore.get(deploymentId);
        if (!deployment) {
            return undefined;
        }

        try {
            const agent = this.agentManager.getClient(appSettings.serverId ?? "local");
            const snapshot = await agent.captureReleaseSnapshot(projectName, appSettings, globalSettings);
            const release = this.releaseStore.save(projectName, deployment, snapshot, globalSettings.releaseSnapshotLimit);
            this.appendDeploymentLine(projectName, deploymentId, "stdout", release.rollbackAvailable
                ? `--> Release snapshot saved: ${release.id}.`
                : `--> Release snapshot saved: ${release.id}. Rollback unavailable because ${release.rollbackUnavailableReason}`);
            return release;
        } catch (error) {
            this.appendDeploymentLine(projectName, deploymentId, "stderr", `--> Release snapshot skipped: ${readErrorMessage(error)}`);
            return undefined;
        }
    }

    private async cleanupCheckoutAfterDeploy(projectName: string, deploymentId: string, appSettings: ProjectSettings, globalSettings: GlobalSettings) {
        await this.cleanupTempDeploymentCheckout(projectName, appSettings, globalSettings, deploymentId);
        await this.cleanupReleaseDeploymentCheckout(projectName, appSettings, globalSettings, deploymentId);
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

    private async cleanupReleaseDeploymentCheckout(projectName: string, appSettings: ProjectSettings, globalSettings: GlobalSettings, deploymentId?: string) {
        if (!globalSettings.cleanupAfterDeploy) {
            return;
        }

        const serverId = appSettings.serverId ?? "local";
        const agent = this.agentManager.getClient(serverId);
        this.logCleanupLine(projectName, deploymentId, "stdout", "--> Verifying stable release checkout bind mounts...");

        try {
            const releasePath = assertSafeDeletePath(releaseDeployPath(appSettings.path ?? defaultProjectPath(globalSettings, projectName)), globalSettings.dataRoot);
            const bindMountInspection = await agent.inspectCheckoutBindMounts(releasePath);
            if (bindMountInspection.references.length > 0) {
                this.logCleanupLine(projectName, deploymentId, "stdout", `--> Release cleanup skipped: ${bindMountInspection.references.length} running bind mount(s) still reference the stable release checkout.`);
                return;
            }

            const cleanup = await agent.deleteCheckout(releasePath);
            for (const step of cleanup.steps) {
                this.logCleanupLine(projectName, deploymentId, "stdout", `--> ${step}`);
            }
            this.logCleanupLine(projectName, deploymentId, "stdout", "--> Release checkout cleanup completed.");
        } catch (error) {
            this.logCleanupLine(projectName, deploymentId, "stderr", `--> Release cleanup skipped: ${readErrorMessage(error)}`);
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
            this.scheduledDeploymentTargets.delete(target.id);
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

            if (this.reconcileQueuedRegistryReplica(deployment.projectName, deployment, appSettings)) {
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
                const targetSettings = { ...appSettings, serverId };
                await this.cleanupTempDeploymentCheckout(projectName, targetSettings, globalSettings);
                await this.cleanupReleaseDeploymentCheckout(projectName, targetSettings, globalSettings);
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
            if (this.reconcileQueuedRegistryReplica(projectName, target, appSettings)) {
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
        this.scheduledDeploymentTargets.add(deployment.id);
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
                const deployment = this.deploymentStore.get(deploymentId);
                if (deployment) this.handleSuccessfulDeployment(projectName, deployment, appSettings, globalSettings);
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
                this.scheduledDeploymentTargets.delete(deploymentId);
                this.broadcastDeploymentUpdate(projectName);
                if (current) this.failQueuedRegistryReplicas(projectName, current, appSettings, "The primary build/publish target failed.");
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

        const reconciled = this.deploymentStore.get(deploymentId);
        if (reconciled?.status === "succeeded") {
            this.scheduledDeploymentTargets.delete(deploymentId);
            this.startQueuedRegistryReplicas(projectName, reconciled, appSettings);
        } else if (reconciled?.status === "failed") {
            this.scheduledDeploymentTargets.delete(deploymentId);
            this.failQueuedRegistryReplicas(projectName, reconciled, appSettings, "The primary build/publish target failed during recovery.");
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

    private async resolveDeploymentSecrets(appSettings: ProjectSettings): Promise<ProjectSettings> {
        const secrets = appSettings.envSecrets ?? [];
        const infisicalBindings = secrets.filter((secret) => secret.source === "infisical");
        const targetSettings = { ...appSettings };
        delete targetSettings.infisical;
        if (!secrets.some((secret) => secret.source === "vault") && !infisicalBindings.length) {
            return targetSettings;
        }

        const infisicalValues = infisicalBindings.length
            ? await fetchInfisicalSecrets(appSettings.infisical ?? {
                enabled: false,
                siteUrl: "",
                clientId: "",
                clientSecret: "",
                projectId: "",
                environment: "",
                secretPath: "/"
            }, infisicalBindings.map((secret) => ({
                name: secret.infisicalSecretName ?? "",
                path: secret.infisicalSecretPath?.trim() || appSettings.infisical?.secretPath || "/"
            })))
            : new Map<string, string>();

        return {
            ...targetSettings,
            envSecrets: secrets.map((secret) => {
                if (secret.source === "infisical") {
                    const secretName = secret.infisicalSecretName?.trim() ?? "";
                    const secretPath = secret.infisicalSecretPath?.trim() || appSettings.infisical?.secretPath || "/";
                    const value = infisicalValues.get(infisicalSecretReferenceKey(secretName, secretPath));
                    if (value === undefined) {
                        throw new Error("Infisical secret binding for " + secret.service + "." + secret.key + " could not be resolved.");
                    }
                    return {
                        service: secret.service,
                        key: secret.key,
                        value,
                        mode: secret.mode,
                        source: "inline" as const,
                        exposure: secret.exposure,
                        helperCommand: secret.helperCommand
                    };
                }
                if (secret.source !== "vault") {
                    return secret;
                }
                if (!secret.vaultSecretId) {
                    throw new Error(`Vault secret reference for ${secret.service}.${secret.key} is missing a secret ID.`);
                }

                return {
                    service: secret.service,
                    key: secret.key,
                    value: this.vaultSecretStore.resolveValue(secret.vaultSecretId),
                    mode: "docker_secret" as const,
                    source: "inline" as const,
                    exposure: secret.exposure === "env" ? "env" as const : "file" as const,
                    helperCommand: secret.exposure === "env" ? secret.helperCommand ?? "" : ""
                };
            })
        };
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

function releaseDeployPath(projectRoot: string) {
    return `${projectRoot.replace(/\/+$/, "")}/.updater/release`;
}
