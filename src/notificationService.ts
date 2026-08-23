import net from "node:net";
import tls from "node:tls";
import { DeploymentRecord } from "./deploymentStore.js";
import { ControllerEvent } from "./eventBus.js";
import { GlobalSettingsStore } from "./globalSettingsStore.js";
import { NotificationStore } from "./notificationStore.js";
import { NotificationChannelSettings, NotificationDeliveryRecord, NotificationEventType, NotificationSettings, RuntimeServiceStatus } from "./types.js";

interface NotificationMessage {
    event: NotificationEventType;
    title: string;
    body: string;
}

interface NotificationPlugin {
    type: NotificationChannelSettings["type"];
    send(channel: NotificationChannelSettings, message: NotificationMessage): Promise<void>;
}

export class NotificationService {
    private readonly deploymentStatus = new Map<string, DeploymentRecord["status"]>();
    private readonly serviceState = new Map<string, boolean>();
    private readonly plugins = new Map<NotificationChannelSettings["type"], NotificationPlugin>([
        ["slack", new SlackNotificationPlugin()],
        ["pushover", new PushoverNotificationPlugin()],
        ["email", new EmailNotificationPlugin()]
    ]);

    constructor(
        private readonly globalSettingsStore: GlobalSettingsStore,
        private readonly notificationStore: NotificationStore,
        private readonly publishNotification: (record: NotificationDeliveryRecord) => void = () => {}
    ) {}

    async handleEvent(event: ControllerEvent) {
        if (event.type === "deployment.updated" && event.deployment) {
            await this.handleDeployment(event.projectName, event.deployment);
            return;
        }

        if (event.type === "runtime.status") {
            await this.handleRuntimeStatus(event.projectId ?? event.projectName, event.projectName, event.status.services);
        }
    }

    async sendTest(channelId?: string) {
        const settings = this.globalSettingsStore.readSettings().notifications;
        const channels = activeChannels(settings).filter((channel) => !channelId || channel.id === channelId);
        if (!channels.length) {
            throw new Error(channelId ? "Notification channel does not exist or is disabled." : "No enabled notification channels are configured.");
        }

        await this.dispatch({ ...settings, enabled: true, events: { ...settings.events, deploymentStarted: true } }, {
            event: "deployment.started",
            title: "Deploy notification test",
            body: "This is a test notification from Deploy."
        }, channels);
        return { ok: true, channels: channels.map((channel) => ({ id: channel.id, name: channel.name, type: channel.type })) };
    }

    private async handleDeployment(projectName: string, deployment: DeploymentRecord) {
        const previous = this.deploymentStatus.get(deployment.id);
        this.deploymentStatus.set(deployment.id, deployment.status);

        if (previous === deployment.status) {
            return;
        }

        if (deployment.status === "running") {
            await this.notify("deployment.started", `Deployment started: ${projectName}`, `${projectName} deployment started by ${deployment.trigger}.`, {
                projectId: deployment.projectId,
                projectName
            });
        } else if (deployment.status === "succeeded") {
            await this.notify("deployment.succeeded", `Deployment finished: ${projectName}`, `${projectName} deployment completed successfully.`, {
                projectId: deployment.projectId,
                projectName
            });
        } else if (deployment.status === "failed") {
            await this.notify("deployment.failed", `Deployment failed: ${projectName}`, `${projectName} deployment failed${deployment.error ? `: ${deployment.error}` : "."}`, {
                projectId: deployment.projectId,
                projectName
            });
        }
    }

    private async handleRuntimeStatus(projectKey: string, projectName: string, services: RuntimeServiceStatus[]) {
        for (const service of services) {
            const key = `${projectKey}:${service.service}`;
            const currentUp = isServiceUp(service);
            const previousUp = this.serviceState.get(key);
            this.serviceState.set(key, currentUp);

            if (previousUp === true && !currentUp) {
                const state = service.health ? `${service.state}/${service.health}` : service.state;
                await this.notify("service.down", `Service down: ${projectName}/${service.service}`, `${projectName} service ${service.service} is ${state}.`, {
                    projectId: projectKey,
                    projectName,
                    service: service.service
                });
            }
        }
    }

    private async notify(event: NotificationEventType, title: string, body: string, context: { projectId?: string; projectName?: string; service?: string } = {}) {
        const settings = this.globalSettingsStore.readSettings().notifications;
        await this.dispatch(settings, { event, title, body }, undefined, context);
    }

    private async dispatch(
        settings: NotificationSettings,
        message: NotificationMessage,
        channels = activeChannels(settings),
        context: { projectId?: string; projectName?: string; service?: string } = {}
    ) {
        if (!settings.enabled || !isEventEnabled(settings, message.event)) {
            return;
        }

        if (!channels.length) {
            this.recordNotification({
                ...context,
                event: message.event,
                title: message.title,
                body: message.body,
                status: "skipped",
                error: "No enabled notification channels are configured."
            });
            return;
        }

        await Promise.all(channels.map(async (channel) => {
            const plugin = this.plugins.get(channel.type);
            try {
                if (!plugin) {
                    throw new Error(`Notification plugin ${channel.type} is not available.`);
                }
                await plugin.send(channel, message);
                this.recordNotification({
                    ...context,
                    event: message.event,
                    channelId: channel.id,
                    channelName: channel.name,
                    channelType: channel.type,
                    title: message.title,
                    body: message.body,
                    status: "sent"
                });
            } catch (error) {
                const messageText = readErrorMessage(error);
                console.warn(`[notifications] ${messageText}`);
                this.recordNotification({
                    ...context,
                    event: message.event,
                    channelId: channel.id,
                    channelName: channel.name,
                    channelType: channel.type,
                    title: message.title,
                    body: message.body,
                    status: "failed",
                    error: messageText
                });
            }
        }));
    }

    private recordNotification(record: Parameters<NotificationStore["record"]>[0]) {
        const saved = this.notificationStore.record(record);
        this.publishNotification(saved);
        return saved;
    }
}

class SlackNotificationPlugin implements NotificationPlugin {
    readonly type = "slack" as const;

    async send(channel: NotificationChannelSettings, message: NotificationMessage) {
        if (!channel.slackWebhookUrl) {
            throw new Error(`${channel.name} is missing a Slack webhook URL.`);
        }

        const response = await fetch(channel.slackWebhookUrl, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ text: `*${message.title}*\n${message.body}` })
        });
        if (!response.ok) {
            throw new Error(`${channel.name} Slack notification failed with HTTP ${response.status}.`);
        }
    }
}

class PushoverNotificationPlugin implements NotificationPlugin {
    readonly type = "pushover" as const;

    async send(channel: NotificationChannelSettings, message: NotificationMessage) {
        if (!channel.pushoverToken || !channel.pushoverUser) {
            throw new Error(`${channel.name} is missing Pushover token or user key.`);
        }

        const response = await fetch("https://api.pushover.net/1/messages.json", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                token: channel.pushoverToken,
                user: channel.pushoverUser,
                title: message.title,
                message: message.body
            })
        });
        if (!response.ok) {
            throw new Error(`${channel.name} Pushover notification failed with HTTP ${response.status}.`);
        }
    }
}

class EmailNotificationPlugin implements NotificationPlugin {
    readonly type = "email" as const;

    async send(channel: NotificationChannelSettings, message: NotificationMessage) {
        if (!channel.smtpHost || !channel.emailTo || !channel.emailFrom) {
            throw new Error(`${channel.name} is missing SMTP host, sender, or recipient.`);
        }

        await sendSmtpMail(channel, message);
    }
}

function activeChannels(settings: NotificationSettings) {
    return settings.channels.filter((channel) => channel.enabled);
}

function isEventEnabled(settings: NotificationSettings, event: NotificationEventType) {
    switch (event) {
        case "deployment.started":
            return settings.events.deploymentStarted;
        case "deployment.succeeded":
            return settings.events.deploymentSucceeded;
        case "deployment.failed":
            return settings.events.deploymentFailed;
        case "service.down":
            return settings.events.serviceDown;
    }
}

function isServiceUp(service: RuntimeServiceStatus) {
    const state = service.state.toLowerCase();
    const health = service.health?.toLowerCase() ?? "";
    if (health === "unhealthy") {
        return false;
    }
    return state === "running";
}

async function sendSmtpMail(channel: NotificationChannelSettings, message: NotificationMessage) {
    const port = channel.smtpPort || (channel.smtpSecure ? 465 : 587);
    const socket = channel.smtpSecure
        ? tls.connect({ host: channel.smtpHost, port, servername: channel.smtpHost })
        : net.connect({ host: channel.smtpHost, port });
    const client = new SmtpClient(socket);
    await client.expect(220);
    await client.command(`EHLO ${hostnameForSmtp()}`, 250);
    if (!channel.smtpSecure) {
        await client.command("STARTTLS", 220);
        client.upgrade(channel.smtpHost ?? "");
        await client.command(`EHLO ${hostnameForSmtp()}`, 250);
    }
    if (channel.smtpUsername && channel.smtpPassword) {
        await client.command(`AUTH PLAIN ${Buffer.from(`\0${channel.smtpUsername}\0${channel.smtpPassword}`).toString("base64")}`, 235);
    }
    await client.command(`MAIL FROM:<${channel.emailFrom}>`, 250);
    await client.command(`RCPT TO:<${channel.emailTo}>`, [250, 251]);
    await client.command("DATA", 354);
    await client.write(`${formatEmail(channel, message)}\r\n.`);
    await client.expect(250);
    await client.command("QUIT", 221);
    client.close();
}

class SmtpClient {
    private buffer = "";
    private waiters: Array<(line: string) => void> = [];

    constructor(private socket: net.Socket | tls.TLSSocket) {
        socket.setEncoding("utf8");
        socket.on("data", (chunk) => this.onData(String(chunk)));
    }

    async command(command: string, expected: number | number[]) {
        await this.write(command);
        await this.expect(expected);
    }

    write(line: string) {
        return new Promise<void>((resolve, reject) => {
            this.socket.write(`${line}\r\n`, (error) => error ? reject(error) : resolve());
        });
    }

    expect(expected: number | number[]) {
        const codes = Array.isArray(expected) ? expected : [expected];
        return this.nextResponse().then((line) => {
            const code = Number(line.slice(0, 3));
            if (!codes.includes(code)) {
                throw new Error(`SMTP expected ${codes.join("/")} but received ${line}`);
            }
        });
    }

    upgrade(host: string) {
        this.socket = tls.connect({ socket: this.socket, servername: host });
        this.socket.setEncoding("utf8");
        this.socket.on("data", (chunk) => this.onData(String(chunk)));
    }

    close() {
        this.socket.end();
    }

    private nextResponse() {
        return new Promise<string>((resolve) => {
            this.waiters.push(resolve);
        });
    }

    private onData(chunk: string) {
        this.buffer += chunk;
        const lines = this.buffer.split(/\r?\n/);
        this.buffer = lines.pop() ?? "";
        for (const line of lines) {
            if (/^\d{3} /.test(line)) {
                this.waiters.shift()?.(line);
            }
        }
    }
}

function formatEmail(channel: NotificationChannelSettings, message: NotificationMessage) {
    return [
        `From: ${channel.emailFrom}`,
        `To: ${channel.emailTo}`,
        `Subject: ${message.title}`,
        "Content-Type: text/plain; charset=utf-8",
        "",
        message.body
    ].join("\r\n");
}

function hostnameForSmtp() {
    return "deploy.local";
}

function readErrorMessage(error: unknown) {
    return error instanceof Error ? error.message : String(error);
}
