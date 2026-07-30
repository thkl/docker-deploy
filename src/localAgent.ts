import { CheckoutCleanupResult, removeCheckoutPath } from "./checkoutCleanup.js";
import { importProjectCompose, ImportedCompose } from "./composeImport.js";
import { deleteCheckoutPath, detectTraefik, dispatchBuildWorker, followRuntimeLogs, inspectProjectStatus, readRuntimeLogs, DeploymentHooks, RuntimeLogHooks, stopProjectContainers } from "./deploy.js";
import { GlobalSettings, ProjectSettings } from "./types.js";
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
        dispatchBuildWorker(projectName, appSettings, globalSettings, hooks);
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
     * Deletes a checkout path through a Docker worker on the local target server.
     */
    deleteCheckout(checkoutPath: string): Promise<CheckoutCleanupResult> {
        return removeCheckoutPath(checkoutPath, (path) => deleteCheckoutPath(path));
    }

    /**
     * Detects whether Traefik is available on the target Docker server.
     */
    detectTraefik(globalSettings: GlobalSettings) {
        return detectTraefik(globalSettings);
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
}
