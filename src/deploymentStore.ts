import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";

export type DeploymentStatus = "running" | "succeeded" | "failed";
export type DeploymentTrigger = "webhook" | "ci" | "manual";
export type DeploymentStream = "stdout" | "stderr";

export interface DeploymentRecord {
    id: string;
    projectName: string;
    trigger: DeploymentTrigger;
    status: DeploymentStatus;
    startedAt: string;
    finishedAt?: string;
    exitCode?: number | string;
    error?: string;
    log: string;
}

type DeploymentData = Record<string, DeploymentRecord[]>;

const maxHistoryPerProject = 10;
const maxLogLength = 120_000;

/**
 * JSON-backed deployment history store.
 *
 * Deployment records are append-only during a run and are trimmed per project
 * so logs do not grow without bound. SQLite should eventually replace this
 * with normalized deployment and deployment_log tables.
 */
export class DeploymentStore {
    constructor(private readonly deploymentPath = join("./data", "deployments.json")) {}

    /**
     * Lists deployment history for one project in chronological order.
     */
    list(projectName: string) {
        return this.readData()[projectName] ?? [];
    }

    /**
     * Returns the newest deployment record for a project.
     */
    latest(projectName: string) {
        return this.list(projectName).at(-1) ?? null;
    }

    /**
     * Removes all deployment history for a deleted project.
     */
    deleteProject(projectName: string) {
        const data = this.readData();
        delete data[projectName];
        this.writeData(data);
    }

    /**
     * Creates a running deployment record before the worker process starts.
     */
    start(projectName: string, trigger: DeploymentTrigger) {
        const data = this.readData();
        const record: DeploymentRecord = {
            id: `${Date.now()}-${randomUUID().slice(0, 8)}`,
            projectName,
            trigger,
            status: "running",
            startedAt: new Date().toISOString(),
            log: `Deployment queued by ${trigger} at ${new Date().toISOString()}\n`
        };

        data[projectName] = [...(data[projectName] ?? []), record].slice(-maxHistoryPerProject);
        this.writeData(data);

        return record;
    }

    /**
     * Appends stdout or stderr output to a running deployment log.
     */
    append(projectName: string, deploymentId: string, stream: DeploymentStream, chunk: string) {
        this.updateRecord(projectName, deploymentId, (record) => {
            const prefix = stream === "stderr" ? "[stderr] " : "";
            record.log = trimLog(`${record.log}${prefix}${chunk}`);
        });
    }

    /**
     * Marks a running deployment as succeeded or failed.
     */
    finish(projectName: string, deploymentId: string, status: Exclude<DeploymentStatus, "running">, details?: { error?: string; exitCode?: number | string }) {
        this.updateRecord(projectName, deploymentId, (record) => {
            record.status = status;
            record.finishedAt = new Date().toISOString();
            record.error = details?.error;
            record.exitCode = details?.exitCode;
        });
    }

    /**
     * Finds and mutates one deployment record, then persists the full history.
     */
    private updateRecord(projectName: string, deploymentId: string, updater: (record: DeploymentRecord) => void) {
        const data = this.readData();
        const record = (data[projectName] ?? []).find((candidate) => candidate.id === deploymentId);

        if (!record) {
            return;
        }

        updater(record);
        this.writeData(data);
    }

    /**
     * Reads and validates the deployment history file.
     */
    private readData(): DeploymentData {
        if (!existsSync(this.deploymentPath)) {
            return {};
        }

        const content = readFileSync(this.deploymentPath, "utf8").trim();
        if (!content) {
            return {};
        }

        const parsed = JSON.parse(content);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            throw new Error("Deployment data must be an object keyed by repository name.");
        }

        return parsed as DeploymentData;
    }

    /**
     * Writes deployment history to disk.
     */
    private writeData(data: DeploymentData) {
        mkdirSync(dirname(this.deploymentPath), { recursive: true });
        writeFileSync(this.deploymentPath, `${JSON.stringify(data, null, 2)}\n`);
    }
}

/**
 * Keeps only the latest part of a large deployment log.
 */
function trimLog(log: string) {
    if (log.length <= maxLogLength) {
        return log;
    }

    return `... log trimmed to last ${maxLogLength} characters ...\n${log.slice(-maxLogLength)}`;
}
