import assert from "node:assert/strict";
import { test } from "node:test";
import { NotificationService } from "../dist/notificationService.js";

test("does not send deployment started again for a recovered running deployment", async () => {
    const sent = [];
    const store = new MemoryNotificationStore();
    const service = createNotificationService(store, sent);
    const deployment = deploymentRecord({
        status: "running",
        startedAt: "2024-01-01T00:00:00.000Z"
    });

    await service.handleEvent({
        type: "deployment.updated",
        projectName: "Deploy",
        deployment
    });
    await service.handleEvent({
        type: "deployment.updated",
        projectName: "Deploy",
        deployment: { ...deployment, status: "succeeded", finishedAt: "2024-01-01T00:01:00.000Z" }
    });

    assert.deepEqual(sent.map((message) => message.event), ["deployment.succeeded"]);
    assert.deepEqual(store.records.map((record) => record.event), ["deployment.succeeded"]);
});

test("dedupes deployment notifications across notification service instances", async () => {
    const sent = [];
    const store = new MemoryNotificationStore();
    const deployment = deploymentRecord({
        status: "running",
        startedAt: "2024-01-01T00:00:00.000Z"
    });
    const firstService = createNotificationService(store, sent, Date.parse(deployment.startedAt) - 1);
    const secondService = createNotificationService(store, sent, Date.parse(deployment.startedAt) - 1);

    await firstService.handleEvent({
        type: "deployment.updated",
        projectName: "Deploy",
        deployment
    });
    await secondService.handleEvent({
        type: "deployment.updated",
        projectName: "Deploy",
        deployment
    });

    assert.equal(sent.length, 1);
    assert.equal(store.records.length, 1);
    assert.equal(store.records[0].dedupeKey, "deployment.started:deployment-1:test-channel");
});

function createNotificationService(store, sent, controllerStartedAt = Date.now()) {
    const service = new NotificationService(
        {
            readSettings() {
                return {
                    notifications: {
                        enabled: true,
                        healthPollingEnabled: true,
                        healthPollingIntervalSeconds: 60,
                        events: {
                            deploymentStarted: true,
                            deploymentSucceeded: true,
                            deploymentFailed: true,
                            serviceDown: true
                        },
                        channels: [
                            {
                                id: "test-channel",
                                type: "slack",
                                name: "Test channel",
                                enabled: true,
                                slackWebhookUrl: "https://example.test/webhook"
                            }
                        ]
                    }
                };
            }
        },
        { resolveProject: () => undefined },
        store
    );
    service.controllerStartedAt = controllerStartedAt;
    service.plugins.set("slack", {
        type: "slack",
        async send(_channel, message) {
            sent.push(message);
        }
    });
    return service;
}

function deploymentRecord(overrides) {
    return {
        id: "deployment-1",
        projectId: "project-1",
        projectName: "Deploy",
        serverId: "local",
        trigger: "manual",
        status: "running",
        startedAt: new Date().toISOString(),
        log: "",
        ...overrides
    };
}

class MemoryNotificationStore {
    records = [];

    record(payload) {
        const record = {
            id: `notification-${this.records.length + 1}`,
            createdAt: new Date().toISOString(),
            ...payload
        };
        this.records.push(record);
        return record;
    }

    hasDedupeKey(dedupeKey) {
        return this.records.some((record) => record.dedupeKey === dedupeKey && record.status === "sent");
    }
}
