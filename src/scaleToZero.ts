import { AgentManager } from "./agentManager.js";
import { GlobalSettings, ProjectSettings, RuntimeStatus, ScaleToZeroRuntimeStatus } from "./types.js";

/**
 * Coordinates request-triggered starts and idle shutdowns. The controller is
 * deliberately independent of Traefik: Traefik's ForwardAuth middleware
 * calls `wake()`, then forwards the original request after it returns.
 */
export class ScaleToZeroController {
    private readonly locks = new Map<string, Promise<void>>();
    private readonly lastRequestAt = new Map<string, number>();
    private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
    private readonly waking = new Set<string>();
    private readonly errors = new Map<string, string>();
    private readonly suspendedAt = new Map<string, string>();
    private readonly lastWakeAt = new Map<string, string>();
    private stateChanged?: (projectName: string) => void;

    constructor(private readonly agentManager: AgentManager) {}

    setStateChangedHandler(handler: (projectName: string) => void) {
        this.stateChanged = handler;
    }

    decorateStatus(projectName: string, settings: ProjectSettings, status: RuntimeStatus, globalSettings?: GlobalSettings): RuntimeStatus {
        if (!settings.scaleToZero?.enabled) {
            return status;
        }

        if (globalSettings && !this.timers.has(projectName) && !this.waking.has(projectName) && this.isRunningTarget(projectName, settings, status)) {
            this.lastRequestAt.set(projectName, Date.now());
            this.scheduleIdleStop(projectName, settings, globalSettings);
        }

        const scaleStatus: ScaleToZeroRuntimeStatus = {
            state: this.waking.has(projectName)
                ? "waking"
                : this.errors.has(projectName)
                    ? "error"
                    : this.isSuspended(projectName, settings, status)
                        ? "suspended"
                        : this.lastRequestAt.has(projectName)
                            ? "idle"
                            : "running",
            checkedAt: status.checkedAt,
            ...(this.lastRequestAt.has(projectName) ? { idleSince: new Date(this.lastRequestAt.get(projectName)!).toISOString() } : {}),
            ...(this.suspendedAt.has(projectName) ? { suspendedSince: this.suspendedAt.get(projectName) } : {}),
            ...(this.lastWakeAt.has(projectName) ? { lastWakeAt: this.lastWakeAt.get(projectName) } : {}),
            ...(this.errors.has(projectName) ? { error: this.errors.get(projectName) } : {})
        };

        return { ...status, scaleToZero: scaleStatus };
    }

    async wake(projectName: string, settings: ProjectSettings, globalSettings: GlobalSettings) {
        const scale = settings.scaleToZero;
        if (!scale?.enabled) {
            throw new Error("Scale-to-zero is not enabled for this project.");
        }

        this.lastRequestAt.set(projectName, Date.now());
        this.errors.delete(projectName);
        this.waking.add(projectName);
        this.notifyStateChanged(projectName);
        const previous = this.locks.get(projectName) ?? Promise.resolve();
        const operation = previous.then(() => this.ensureRunning(projectName, settings, globalSettings));
        const tracked = operation.catch(() => undefined);
        this.locks.set(projectName, tracked);

        try {
            await operation;
            const wokeAt = new Date().toISOString();
            this.lastWakeAt.set(projectName, wokeAt);
            this.suspendedAt.delete(projectName);
            this.notifyStateChanged(projectName);
        } catch (error) {
            this.errors.set(projectName, error instanceof Error ? error.message : "Application wake failed.");
            this.notifyStateChanged(projectName);
            throw error;
        } finally {
            this.waking.delete(projectName);
            if (this.locks.get(projectName) === tracked) {
                this.locks.delete(projectName);
            }
        }

        this.scheduleIdleStop(projectName, settings, globalSettings);
    }

    private async ensureRunning(projectName: string, settings: ProjectSettings, globalSettings: GlobalSettings) {
        const client = this.agentManager.getClient(settings.serverId ?? "local");
        const services = targetServices(projectName, settings);
        if (!services.length) {
            throw new Error("Scale-to-zero requires at least one application service.");
        }

        const status = await client.inspectStatus(projectName, settings, globalSettings);
        for (const service of services) {
            const current = findService(status, service);
            if (!current || current.state !== "running" || current.health === "unhealthy") {
                await client.runtimeAction(projectName, settings, globalSettings, service, current?.state === "paused" ? "unpause" : "start");
            }
        }

        const deadline = Date.now() + (settings.scaleToZero?.startupTimeoutSeconds ?? 120) * 1000;
        let lastStatus: RuntimeStatus | undefined;
        while (Date.now() < deadline) {
            lastStatus = await client.inspectStatus(projectName, settings, globalSettings);
            const currentStatus = lastStatus;
            if (currentStatus && services.every((service) => isReady(findService(currentStatus, service)))) {
                return;
            }
            await delay(1000);
        }

        const details = lastStatus?.services.map((service) => `${service.service}: ${service.state}${service.health ? `/${service.health}` : ""}`).join(", ");
        throw new Error(`Application did not become ready within ${settings.scaleToZero?.startupTimeoutSeconds ?? 120}s${details ? ` (${details})` : ""}.`);
    }

    private scheduleIdleStop(projectName: string, settings: ProjectSettings, globalSettings: GlobalSettings) {
        const existing = this.timers.get(projectName);
        if (existing) {
            clearTimeout(existing);
        }

        const timeout = Math.max(30, settings.scaleToZero?.idleTimeoutSeconds ?? 900) * 1000;
        const timer = setTimeout(() => {
            void this.stopIfIdle(projectName, settings, globalSettings);
        }, timeout);
        timer.unref?.();
        this.timers.set(projectName, timer);
    }

    private async stopIfIdle(projectName: string, settings: ProjectSettings, globalSettings: GlobalSettings) {
        const lastRequest = this.lastRequestAt.get(projectName) ?? 0;
        const idleTimeout = Math.max(30, settings.scaleToZero?.idleTimeoutSeconds ?? 900) * 1000;
        if (Date.now() - lastRequest < idleTimeout) {
            this.scheduleIdleStop(projectName, settings, globalSettings);
            return;
        }

        const previous = this.locks.get(projectName) ?? Promise.resolve();
        const operation = previous.then(async () => {
            if (Date.now() - (this.lastRequestAt.get(projectName) ?? 0) < idleTimeout) {
                return;
            }
            const client = this.agentManager.getClient(settings.serverId ?? "local");
            const status = await client.inspectStatus(projectName, settings, globalSettings);
            for (const service of targetServices(projectName, settings)) {
                if (isRunning(findService(status, service))) {
                    await client.runtimeAction(projectName, settings, globalSettings, service, settings.deploymentStrategy === "swarm" ? "stop" : "pause");
                }
            }
            this.suspendedAt.set(projectName, new Date().toISOString());
            this.notifyStateChanged(projectName);
        });
        const tracked = operation.catch(() => undefined);
        this.locks.set(projectName, tracked);
        try {
            await operation;
        } catch (error) {
            console.error(`[scale-to-zero] Could not stop ${projectName}:`, error);
        } finally {
            if (this.locks.get(projectName) === tracked) {
                this.locks.delete(projectName);
            }
        }
    }

    private isSuspended(projectName: string, settings: ProjectSettings, status: RuntimeStatus) {
        const services = targetServices(projectName, settings);
        return services.length > 0 && services.every((service) => {
            const current = findService(status, service);
            return !current || /^(paused|stopped)/i.test(current.state);
        });
    }

    private isRunningTarget(projectName: string, settings: ProjectSettings, status: RuntimeStatus) {
        const services = targetServices(projectName, settings);
        return services.length > 0 && services.every((service) => isRunning(findService(status, service)));
    }

    private notifyStateChanged(projectName: string) {
        this.stateChanged?.(projectName);
    }
}

export function targetServices(projectName: string, settings: ProjectSettings) {
    return settings.scaleToZero?.services?.length
        ? settings.scaleToZero.services
        : settings.traefik?.service
            ? [settings.traefik.service]
            : [projectName];
}

function findService(status: RuntimeStatus, serviceName: string) {
    return status.services.find((service) => service.service === serviceName || service.containerName === serviceName || service.containerId === serviceName);
}

function isRunning(service: ReturnType<typeof findService>) {
    return service?.state.toLowerCase().startsWith("running") ?? false;
}

function isReady(service: ReturnType<typeof findService>) {
    return isRunning(service) && service?.health !== "unhealthy" && service?.health !== "starting";
}

function delay(milliseconds: number) {
    return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}
