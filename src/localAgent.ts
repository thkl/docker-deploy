import { CheckoutCleanupResult, removeCheckoutPath } from "./checkoutCleanup.js";
import { inspectCompose } from "./composeInspection.js";
import { validateCompose } from "./composeValidation.js";
import { importProjectCompose, ImportedCompose } from "./composeImport.js";
import { applyTraefikDefaults, backupTraefikConfig, captureProjectReleaseSnapshot, deleteCheckoutPath, detectTraefik, diagnoseProjectTraefik, dispatchBuildWorker, dispatchReleaseRollbackWorker, followContainerLogs, followContainerStats, followRuntimeLogs, inspectCheckoutBindMounts, inspectContainers, inspectDockerTopology, inspectProjectStatus, readContainerLogs, readRuntimeLogs, runRuntimeServiceAction, streamRuntimeServiceAction, testRegistryLogin, validateTraefikConfig, DeploymentHooks, RuntimeLogHooks, stopProjectContainers } from "./deploy.js";
import { browseDockerHostPath } from "./pathBrowser.js";
import { GlobalSettings, ProjectReleaseSnapshot, ProjectSettings, RuntimeServiceAction, TraefikDefaultsPayload } from "./types.js";
import { AgentClient } from "./agentTypes.js";

/**
 * Local target-server agent.
 *
 * This class is the first implementation of the future controller-to-agent
 * boundary. It still runs in-process, but every project operation is reachable
 * through one object so remote WebSocket agents can implement the same shape.
 */
export class LocalAgent implements AgentClient {
    /**
     * Starts a deployment worker for the selected local target server.
     */
    deployProject(projectName: string, appSettings: ProjectSettings, globalSettings: GlobalSettings, hooks: DeploymentHooks = {}) {
        return dispatchBuildWorker(projectName, appSettings, globalSettings, hooks);
    }

    /**
     * Redeploys a captured release snapshot on the local target server.
     */
    deployReleaseSnapshot(release: ProjectReleaseSnapshot, globalSettings: GlobalSettings, hooks: DeploymentHooks = {}) {
        return dispatchReleaseRollbackWorker(release, globalSettings, hooks);
    }

    /**
     * Captures the currently persisted deployment artifact on the target server.
     */
    captureReleaseSnapshot(projectName: string, appSettings: ProjectSettings, globalSettings: GlobalSettings) {
        return captureProjectReleaseSnapshot(projectName, appSettings, globalSettings);
    }

    /**
     * Stops project containers on the local target server.
     */
    stopProject(projectName: string, appSettings: ProjectSettings, globalSettings: GlobalSettings, options: { deleteVolumes?: boolean; removeStack?: boolean } = {}) {
        return stopProjectContainers(projectName, appSettings, globalSettings, options);
    }

    /**
     * Imports Docker Compose content from the local target server checkout.
     */
    importCompose(projectName: string, appSettings: ProjectSettings, globalSettings: GlobalSettings): Promise<ImportedCompose> {
        return importProjectCompose(projectName, appSettings, globalSettings);
    }

    /**
     * Inspects normalized Docker Compose services and resources on the target server.
     */
    inspectCompose(projectName: string, appSettings: ProjectSettings, globalSettings: GlobalSettings) {
        return inspectCompose(projectName, appSettings, globalSettings);
    }

    /**
     * Validates the effective Compose YAML on the target server.
     */
    validateCompose(projectName: string, appSettings: ProjectSettings, globalSettings: GlobalSettings) {
        return validateCompose(projectName, appSettings, globalSettings);
    }

    /**
     * Deletes a checkout path through a Docker worker on the local target server.
     */
    deleteCheckout(checkoutPath: string): Promise<CheckoutCleanupResult> {
        return removeCheckoutPath(checkoutPath, (path) => deleteCheckoutPath(path));
    }

    /**
     * Checks whether running containers still bind mount a checkout path.
     */
    inspectCheckoutBindMounts(checkoutPath: string) {
        return inspectCheckoutBindMounts(checkoutPath);
    }

    /**
     * Detects Docker standalone/Swarm role on the target server.
     */
    inspectDocker() {
        return inspectDockerTopology();
    }

    /**
     * Tests Docker registry credentials from the target server.
     */
    testRegistry(globalSettings: GlobalSettings) {
        return testRegistryLogin(globalSettings);
    }

    /**
     * Lists paths on the Docker host backing this target server.
     */
    browsePath(path: string) {
        return browseDockerHostPath(path);
    }

    /**
     * Detects whether Traefik is available on the target Docker server.
     */
    detectTraefik(globalSettings: GlobalSettings) {
        return detectTraefik(globalSettings);
    }

    /**
     * Exports discovered Traefik config files without modifying the target.
     */
    backupTraefik(serverId: string, globalSettings: GlobalSettings) {
        return backupTraefikConfig(serverId, globalSettings);
    }

    /**
     * Validates discovered Traefik static config without modifying it.
     */
    validateTraefik(serverId: string, globalSettings: GlobalSettings) {
        return validateTraefikConfig(serverId, globalSettings);
    }

    /**
     * Applies guarded common Traefik defaults through target-server Docker mounts.
     */
    applyTraefikDefaults(serverId: string, globalSettings: GlobalSettings, defaults: TraefikDefaultsPayload) {
        return applyTraefikDefaults(serverId, globalSettings, defaults);
    }

    /**
     * Diagnoses Traefik routing for one deployed project.
     */
    diagnoseTraefik(projectName: string, appSettings: ProjectSettings, globalSettings: GlobalSettings) {
        return diagnoseProjectTraefik(projectName, appSettings, globalSettings);
    }

    /**
     * Inspects deployed Compose containers on the local target server.
     */
    inspectStatus(projectName: string, appSettings: ProjectSettings, globalSettings: GlobalSettings) {
        return inspectProjectStatus(projectName, appSettings, globalSettings);
    }

    /**
     * Reads recent runtime logs for a deployed Compose service.
     */
    runtimeLogs(projectName: string, appSettings: ProjectSettings, globalSettings: GlobalSettings, service: string, tail: number) {
        return readRuntimeLogs(projectName, appSettings, globalSettings, service, tail);
    }

    /**
     * Follows runtime logs for a deployed Compose service until stopped.
     */
    followRuntimeLogs(projectName: string, appSettings: ProjectSettings, globalSettings: GlobalSettings, service: string, tail: number, hooks: RuntimeLogHooks = {}) {
        return followRuntimeLogs(projectName, appSettings, globalSettings, service, tail, hooks);
    }

    /** Lists all containers and current resource samples on this Docker host. */
    inspectContainers() {
        return inspectContainers();
    }

    /** Streams live resource samples for containers on this Docker host. */
    followContainerStats(hooks: RuntimeLogHooks = {}) {
        return Promise.resolve(followContainerStats(hooks));
    }

    /** Reads recent logs for a container on this Docker host. */
    containerLogs(containerId: string, tail: number) {
        return readContainerLogs(containerId, tail);
    }

    /** Follows a container log stream on this Docker host. */
    followContainerLogs(containerId: string, tail: number, hooks: RuntimeLogHooks = {}) {
        return followContainerLogs(containerId, tail, hooks);
    }

    /**
     * Runs one runtime action against a deployed Compose service.
     */
    runtimeAction(projectName: string, appSettings: ProjectSettings, globalSettings: GlobalSettings, service: string, action: RuntimeServiceAction) {
        return runRuntimeServiceAction(projectName, appSettings, globalSettings, service, action);
    }

    /**
     * Streams one runtime action against a deployed Compose service.
     */
    followRuntimeAction(projectName: string, appSettings: ProjectSettings, globalSettings: GlobalSettings, service: string, action: RuntimeServiceAction, hooks: RuntimeLogHooks = {}) {
        return streamRuntimeServiceAction(projectName, appSettings, globalSettings, service, action, hooks);
    }
}
