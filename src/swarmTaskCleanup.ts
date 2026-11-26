import { AgentManager } from "./agentManager.js";
import { ContainerRecord, DockerTopology } from "./types.js";
import { logger } from "./logger.js";

interface InspectedNode {
    serverId: string;
    nodeId: string;
    clusterKey: string;
    containers: ContainerRecord[];
}

/** Periodically removes stopped Swarm tasks when a live replica replaces them. */
export class SwarmTaskCleanupService {
    private timer?: ReturnType<typeof setTimeout>;
    private running = false;
    private readonly intervalMs = cleanupIntervalMs();

    constructor(private readonly agentManager: AgentManager) {}

    start() {
        if (this.timer || this.intervalMs === 0) return;
        this.schedule(60_000);
    }

    stop() {
        if (!this.timer) return;
        clearTimeout(this.timer);
        this.timer = undefined;
    }

    private schedule(delayMs = this.intervalMs) {
        this.stop();
        this.timer = setTimeout(() => void this.tick(), delayMs);
    }

    private async tick() {
        this.timer = undefined;
        if (this.running) {
            this.schedule();
            return;
        }

        this.running = true;
        try {
            await this.cleanupStoppedTasks();
        } catch (error) {
            logger.error("Periodic Swarm task cleanup failed.", { error: error instanceof Error ? error.message : String(error) });
        } finally {
            this.running = false;
            this.schedule();
        }
    }

    private async cleanupStoppedTasks() {
        const serverIds = [...new Set(["local", ...this.agentManager.listOnlineSwarmServerIds()])];
        const results = await Promise.all(serverIds.map(async (serverId) => {
            try {
                const agent = this.agentManager.getClient(serverId);
                const topology = await agent.inspectDocker();
                if (!isSwarmNode(topology) || !topology.nodeId) return null;
                const inventory = await agent.inspectContainers();
                return {
                    serverId,
                    nodeId: topology.nodeId,
                    // Without a cluster ID, isolate this node so it can only
                    // match tasks found on the same daemon.
                    clusterKey: topology.swarmClusterId ? `cluster:${topology.swarmClusterId}` : `node:${topology.nodeId}`,
                    containers: inventory.containers
                } satisfies InspectedNode;
            } catch (error) {
                logger.warn("Could not inspect a node during periodic Swarm task cleanup.", {
                    serverId,
                    error: error instanceof Error ? error.message : String(error)
                });
                return null;
            }
        }));

        const nodesByIdentity = new Map<string, InspectedNode>();
        for (const node of results) {
            if (!node) continue;
            const identity = `${node.clusterKey}:${node.nodeId}`;
            if (!nodesByIdentity.has(identity)) nodesByIdentity.set(identity, node);
        }
        const nodes = [...nodesByIdentity.values()];
        if (!nodes.length) return;

        const containers = nodes.flatMap((node) => node.containers.map((container) => ({
            serverId: node.serverId,
            nodeId: node.nodeId,
            clusterKey: node.clusterKey,
            container
        })));
        const stopped = containers.filter(({ container }) => isStoppedSwarmTask(container));
        const running = containers.filter(({ container }) => container.state === "running" && isSwarmTask(container));
        const refreshes = new Map<string, Promise<ContainerRecord[]>>();
        const currentContainers = (serverId: string) => {
            let current = refreshes.get(serverId);
            if (!current) {
                current = this.agentManager.getClient(serverId).inspectContainers().then((inventory) => inventory.containers);
                refreshes.set(serverId, current);
            }
            return current;
        };

        let removedCount = 0;
        let replacementCount = 0;
        for (const oldTask of stopped) {
            const replacements = running.filter((candidate) => candidate.container.id !== oldTask.container.id
                && candidate.clusterKey === oldTask.clusterKey
                && sameSwarmTaskService(oldTask.container, candidate.container));
            if (!replacements.length) continue;
            replacementCount++;

            for (const replacement of replacements) {
                try {
                    const [oldNodeNow, replacementNodeNow] = await Promise.all([
                        currentContainers(oldTask.serverId),
                        currentContainers(replacement.serverId)
                    ]);
                    const oldStillStopped = oldNodeNow.some((container) => container.id === oldTask.container.id
                        && isStoppedSwarmTask(container));
                    const replacementStillRunning = replacementNodeNow.some((container) => container.id === replacement.container.id
                        && container.state === "running"
                        && sameSwarmTaskService(oldTask.container, container));
                    if (!oldStillStopped || !replacementStillRunning) continue;

                    const result = await this.agentManager.getClient(oldTask.serverId).containerAction(oldTask.container.id, "remove");
                    removedCount++;
                    logger.info("Removed stopped Swarm task container with a running replacement.", {
                        container: oldTask.container.name,
                        serverId: oldTask.serverId,
                        replacement: replacement.container.name,
                        replacementServerId: replacement.serverId,
                        service: oldTask.container.composeService,
                        project: oldTask.container.composeProject,
                        output: result.output
                    });
                    break;
                } catch (error) {
                    logger.warn("Could not remove stopped Swarm task container.", {
                        container: oldTask.container.name,
                        serverId: oldTask.serverId,
                        error: error instanceof Error ? error.message : String(error)
                    });
                }
            }
        }

        logger.info("Periodic Swarm task cleanup completed.", {
            inspectedNodes: nodes.length,
            stoppedTasks: stopped.length,
            tasksWithReplacement: replacementCount,
            removed: removedCount
        });
    }
}

function isSwarmNode(topology: DockerTopology) {
    return topology.available && ["swarm-manager", "swarm-worker"].includes(topology.mode);
}

export function isSwarmTask(container: ContainerRecord) {
    return Boolean(container.swarmServiceId || container.swarmTaskId || taskSlot(container));
}

export function isStoppedSwarmTask(container: ContainerRecord) {
    return ["exited", "dead"].includes(container.state) && isSwarmTask(container);
}

export function sameSwarmTaskService(left: ContainerRecord, right: ContainerRecord) {
    if (left.swarmServiceId && right.swarmServiceId && left.swarmServiceId === right.swarmServiceId) {
        return true;
    }

    const leftSlot = taskSlot(left);
    const rightSlot = taskSlot(right);
    if (leftSlot && rightSlot) return leftSlot === rightSlot;

    return false;
}

/** Extracts the stable stack/service/replica portion from a Swarm task name. */
function taskSlot(container: ContainerRecord) {
    const match = container.name.replace(/^\/+/, "").match(/^(.*)\.(\d+)\.[^.]+$/);
    if (!match) return undefined;

    const project = container.composeProject?.trim();
    const service = container.composeService?.trim();
    if (!project || !service || match[1] !== `${project}_${service}`) return undefined;
    return `${project}/${service}/${match[2]}`;
}

function cleanupIntervalMs() {
    const rawValue = process.env.SWARM_TASK_CLEANUP_INTERVAL_MINUTES?.trim();
    if (!rawValue) return 60 * 60 * 1000;

    const minutes = Number(rawValue);
    if (!Number.isFinite(minutes) || minutes < 0) {
        logger.warn("Invalid SWARM_TASK_CLEANUP_INTERVAL_MINUTES; using 60 minutes.");
        return 60 * 60 * 1000;
    }
    if (minutes === 0) return 0;
    return Math.max(1, Math.min(Math.floor(minutes), 24 * 60)) * 60 * 1000;
}
