import { AgentManager } from "./agentManager.js";
import { ConfigStore } from "./configStore.js";
import { ControllerEvent } from "./eventBus.js";
import { GlobalSettingsStore } from "./globalSettingsStore.js";
import { RuntimeStatus } from "./types.js";

export class RuntimeHealthPoller {
    private timer?: ReturnType<typeof setTimeout>;
    private running = false;

    constructor(
        private readonly configStore: ConfigStore,
        private readonly globalSettingsStore: GlobalSettingsStore,
        private readonly agentManager: AgentManager,
        private readonly publishRuntimeStatus: (event: Extract<ControllerEvent, { type: "runtime.status" }>) => void
    ) {}

    start() {
        this.schedule(2_000);
    }

    stop() {
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = undefined;
        }
    }

    private schedule(delayMs = this.intervalMs()) {
        this.stop();
        this.timer = setTimeout(() => void this.tick(), delayMs);
    }

    private async tick() {
        if (this.running) {
            this.schedule();
            return;
        }

        this.running = true;
        try {
            const globalSettings = this.globalSettingsStore.readSettings();
            if (globalSettings.notifications.enabled && globalSettings.notifications.healthPollingEnabled && globalSettings.notifications.events.serviceDown) {
                const config = this.configStore.readConfig();
                await Promise.all(Object.entries(config).map(async ([projectName, appSettings]) => {
                    const status = await this.inspectProject(projectName, appSettings, globalSettings);
                    this.publishRuntimeStatus({
                        type: "runtime.status",
                        projectId: appSettings.id,
                        projectName,
                        status
                    });
                }));
            }
        } finally {
            this.running = false;
            this.schedule();
        }
    }

    private async inspectProject(projectName: string, appSettings: NonNullable<ReturnType<ConfigStore["resolveProject"]>>["settings"], globalSettings: ReturnType<GlobalSettingsStore["readSettings"]>) {
        try {
            return await this.agentManager.getClient(appSettings.serverId ?? "local").inspectStatus(projectName, appSettings, globalSettings);
        } catch (error) {
            return {
                status: "error",
                checkedAt: new Date().toISOString(),
                services: [],
                error: error instanceof Error ? error.message : "Could not inspect runtime status."
            } satisfies RuntimeStatus;
        }
    }

    private intervalMs() {
        const seconds = this.globalSettingsStore.readSettings().notifications.healthPollingIntervalSeconds;
        return Math.max(15, Math.min(seconds || 60, 3600)) * 1000;
    }
}
