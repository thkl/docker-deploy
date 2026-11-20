import { AgentManager } from "./agentManager.js";
import { GlobalSettings, ProjectSettings, RuntimeStatus, ScaleToZeroRuntimeStatus } from "./types.js";
import { logger } from "./logger.js";

/**
 * Coordinates request-triggered starts and idle shutdowns. The controller is
 * deliberately independent of Traefik: Traefik's ForwardAuth middleware
 * calls `wake()`, then forwards the original request after it returns.
 */
export class ScaleToZeroController {
    private static readonly runningCacheTtlMs = 10_000;
    private readonly locks = new Map<string, Promise<void>>();
    private readonly runningCacheUntil = new Map<string, number>();
    private readonly lastActivityAt = new Map<string, number>();
    private readonly lastRequestAt = new Map<string, number>();
    private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
    private readonly generations = new Map<string, number>();
    private readonly disabledProjects = new Set<string>();
    private readonly removedProjects = new Set<string>();
    private readonly waking = new Set<string>();
    private readonly errors = new Map<string, string>();
    private readonly suspendedAt = new Map<string, string>();
    private readonly lastWakeAt = new Map<string, string>();
    private stateChanged?: (projectName: string) => void;

    constructor(private readonly agentManager: AgentManager) {}

    setStateChangedHandler(handler: (projectName: string) => void) {
        this.stateChanged = handler;
    }

    /** Applies saved settings immediately so timers never keep stale project configuration. */
    syncProjectSettings(projectName: string, settings: ProjectSettings, globalSettings: GlobalSettings) {
        const hadTimer = this.timers.has(projectName);
        this.invalidatePendingStop(projectName);

        if (!settings.scaleToZero?.enabled) {
            this.disabledProjects.add(projectName);
            this.clearRuntimeState(projectName);
            this.notifyStateChanged(projectName);
            return;
        }

        this.disabledProjects.delete(projectName);
        this.removedProjects.delete(projectName);
        if (hadTimer && !this.suspendedAt.has(projectName) && !this.waking.has(projectName)) {
            this.scheduleIdleStop(projectName, settings, globalSettings);
        }
        this.notifyStateChanged(projectName);
    }

    /** Cancels all pending scale-to-zero work when a project is deleted or renamed. */
    removeProject(projectName: string) {
        this.invalidatePendingStop(projectName);
        this.disabledProjects.add(projectName);
        this.removedProjects.add(projectName);
        this.clearRuntimeState(projectName);
        this.notifyStateChanged(projectName);
    }

    decorateStatus(projectName: string, settings: ProjectSettings, status: RuntimeStatus, globalSettings?: GlobalSettings): RuntimeStatus {
        if (!settings.scaleToZero?.enabled) {
            return status;
        }

        if (globalSettings && !this.timers.has(projectName) && !this.waking.has(projectName) && this.isRunningTarget(projectName, settings, status)) {
            this.lastActivityAt.set(projectName, Date.now());
            if (!this.suspendedAt.has(projectName)) {
                this.markRunning(projectName);
            }
            this.scheduleIdleStop(projectName, settings, globalSettings);
        }

        const scaleStatus: ScaleToZeroRuntimeStatus = {
            state: this.waking.has(projectName)
                ? "waking"
                : this.errors.has(projectName)
                    ? "error"
                    : this.isSuspended(projectName, settings, status)
                        ? "suspended"
                        : this.lastActivityAt.has(projectName)
                            ? "idle"
                            : "running",
            checkedAt: status.checkedAt,
            ...(this.lastActivityAt.has(projectName) ? { idleSince: new Date(this.lastActivityAt.get(projectName)!).toISOString() } : {}),
            ...(this.lastRequestAt.has(projectName) ? { lastRequestAt: new Date(this.lastRequestAt.get(projectName)!).toISOString() } : {}),
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
        const generation = this.generation(projectName);

        const requestAt = Date.now();
        this.lastActivityAt.set(projectName, requestAt);
        this.lastRequestAt.set(projectName, requestAt);
        this.errors.delete(projectName);

        // ForwardAuth runs before every request. Avoid a Docker API round trip
        // for normal traffic; only the first request after the short cache
        // expires needs to verify or start the workload.
        if (!this.waking.has(projectName) && !this.suspendedAt.has(projectName) && this.isRunningCached(projectName)) {
            this.scheduleIdleStop(projectName, settings, globalSettings);
            this.notifyStateChanged(projectName);
            return;
        }

        this.waking.add(projectName);
        this.notifyStateChanged(projectName);
        const previous = this.locks.get(projectName) ?? Promise.resolve();
        const operation = previous.then(() => this.ensureRunning(projectName, settings, globalSettings, generation));
        const tracked = operation.catch(() => undefined);
        this.locks.set(projectName, tracked);

        try {
            await operation;
            if (this.isCurrentGeneration(projectName, generation)) {
                const wokeAt = new Date().toISOString();
                this.lastWakeAt.set(projectName, wokeAt);
                this.suspendedAt.delete(projectName);
                this.markRunning(projectName);
            }
        } catch (error) {
            if (this.isCurrentGeneration(projectName, generation)) {
                this.errors.set(projectName, error instanceof Error ? error.message : "Application wake failed.");
                this.runningCacheUntil.delete(projectName);
            }
            throw error;
        } finally {
            this.waking.delete(projectName);
            if (this.locks.get(projectName) === tracked) {
                this.locks.delete(projectName);
            }
            if (this.isCurrentGeneration(projectName, generation)) {
                this.notifyStateChanged(projectName);
            }
        }

        if (this.isCurrentGeneration(projectName, generation)) {
            this.scheduleIdleStop(projectName, settings, globalSettings);
        }
    }

    private async ensureRunning(projectName: string, settings: ProjectSettings, globalSettings: GlobalSettings, generation: number) {
        if (!this.isCurrentGeneration(projectName, generation)) return;
        const client = this.agentManager.getClient(settings.serverId ?? "local");
        const services = targetServices(projectName, settings);
        if (!services.length) {
            throw new Error("Scale-to-zero requires at least one application service.");
        }

        const status = await client.inspectStatus(projectName, settings, globalSettings);
        if (!this.isCurrentGeneration(projectName, generation)) return;
        for (const service of services) {
            if (!this.isCurrentGeneration(projectName, generation)) return;
            const current = findService(status, service);
            if (!current || current.state !== "running" || current.health === "unhealthy") {
                await client.runtimeAction(projectName, settings, globalSettings, service, current?.state === "paused" ? "unpause" : "start");
            }
        }

        const deadline = Date.now() + (settings.scaleToZero?.startupTimeoutSeconds ?? 120) * 1000;
        let lastStatus: RuntimeStatus | undefined;
        while (Date.now() < deadline) {
            if (!this.isCurrentGeneration(projectName, generation)) return;
            lastStatus = await client.inspectStatus(projectName, settings, globalSettings);
            if (!this.isCurrentGeneration(projectName, generation)) return;
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
        const lastActivity = this.lastActivityAt.get(projectName) ?? Date.now();
        const remaining = Math.max(0, timeout - (Date.now() - lastActivity));
        const generation = this.generation(projectName);
        const timer = setTimeout(() => {
            void this.stopIfIdle(projectName, settings, globalSettings, generation).finally(() => {
                if (this.timers.get(projectName) === timer) {
                    this.timers.delete(projectName);
                }
            });
        }, remaining);
        timer.unref?.();
        this.timers.set(projectName, timer);
    }

    private async stopIfIdle(projectName: string, settings: ProjectSettings, globalSettings: GlobalSettings, generation: number) {
        if (!this.isCurrentGeneration(projectName, generation)) return;
        const lastActivity = this.lastActivityAt.get(projectName) ?? 0;
        const idleTimeout = Math.max(30, settings.scaleToZero?.idleTimeoutSeconds ?? 900) * 1000;
        if (Date.now() - lastActivity < idleTimeout) {
            this.scheduleIdleStop(projectName, settings, globalSettings);
            return;
        }

        const previous = this.locks.get(projectName) ?? Promise.resolve();
        const operation = previous.then(async () => {
            if (!this.isCurrentGeneration(projectName, generation)) return;
            if (Date.now() - (this.lastActivityAt.get(projectName) ?? 0) < idleTimeout) {
                return;
            }
            const client = this.agentManager.getClient(settings.serverId ?? "local");
            const status = await client.inspectStatus(projectName, settings, globalSettings);
            if (!this.isCurrentGeneration(projectName, generation)) return;
            if (Date.now() - (this.lastActivityAt.get(projectName) ?? 0) < idleTimeout) {
                this.scheduleIdleStop(projectName, settings, globalSettings);
                return;
            }
            for (const service of targetServices(projectName, settings)) {
                if (!this.isCurrentGeneration(projectName, generation)) return;
                if (Date.now() - (this.lastActivityAt.get(projectName) ?? 0) < idleTimeout) {
                    this.scheduleIdleStop(projectName, settings, globalSettings);
                    return;
                }
                if (isRunning(findService(status, service))) {
                    this.runningCacheUntil.delete(projectName);
                    await client.runtimeAction(projectName, settings, globalSettings, service, settings.deploymentStrategy === "swarm" ? "stop" : "pause");
                    if (!this.isCurrentGeneration(projectName, generation)) {
                        if (!this.removedProjects.has(projectName)) {
                            const resumeAction = settings.deploymentStrategy === "swarm" ? "start" : "unpause";
                            await client.runtimeAction(projectName, settings, globalSettings, service, resumeAction).catch((error) => {
                                logger.warn(`[scale-to-zero] Could not resume ${projectName}.${service} after its settings changed: ${error instanceof Error ? error.message : String(error)}`);
                            });
                        }
                        return;
                    }
                }
            }
            if (!this.isCurrentGeneration(projectName, generation)) return;
            this.suspendedAt.set(projectName, new Date().toISOString());
            this.runningCacheUntil.delete(projectName);
            this.notifyStateChanged(projectName);
        });
        const tracked = operation.catch(() => undefined);
        this.locks.set(projectName, tracked);
        try {
            await operation;
        } catch (error) {
            logger.error(`[scale-to-zero] Could not stop ${projectName}: ${error instanceof Error ? error.message : String(error)}`);
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

    private isRunningCached(projectName: string) {
        const expiresAt = this.runningCacheUntil.get(projectName) ?? 0;
        if (expiresAt > Date.now()) {
            return true;
        }
        this.runningCacheUntil.delete(projectName);
        return false;
    }

    private markRunning(projectName: string) {
        this.runningCacheUntil.set(projectName, Date.now() + ScaleToZeroController.runningCacheTtlMs);
    }

    private generation(projectName: string) {
        return this.generations.get(projectName) ?? 0;
    }

    private isCurrentGeneration(projectName: string, generation: number) {
        return this.generation(projectName) === generation && !this.disabledProjects.has(projectName);
    }

    private invalidatePendingStop(projectName: string) {
        const timer = this.timers.get(projectName);
        if (timer) clearTimeout(timer);
        this.timers.delete(projectName);
        this.generations.set(projectName, this.generation(projectName) + 1);
    }

    private clearRuntimeState(projectName: string) {
        this.runningCacheUntil.delete(projectName);
        this.lastActivityAt.delete(projectName);
        this.lastRequestAt.delete(projectName);
        this.errors.delete(projectName);
        this.suspendedAt.delete(projectName);
        this.lastWakeAt.delete(projectName);
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
