import { CheckoutCleanupResult, removeCheckoutPath } from "./checkoutCleanup.js";
import { inspectCompose } from "./composeInspection.js";
import { validateCompose } from "./composeValidation.js";
import { importProjectCompose, ImportedCompose } from "./composeImport.js";
import { backupTraefikConfig, deleteCheckoutPath, detectTraefik, diagnoseProjectTraefik, dispatchBuildWorker, followRuntimeLogs, inspectCheckoutBindMounts, inspectProjectStatus, readRuntimeLogs, runRuntimeServiceAction, streamRuntimeServiceAction, validateTraefikConfig, DeploymentHooks, RuntimeLogHooks, stopProjectContainers } from "./deploy.js";
import { GlobalSettings, ProjectSettings, RuntimeServiceAction } from "./types.js";
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
     * Stops project containers on the local target server.
     */
    stopProject(projectName: string, appSettings: ProjectSettings, globalSettings: GlobalSettings) {
        return stopProjectContainers(projectName, appSettings, globalSettings);
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
