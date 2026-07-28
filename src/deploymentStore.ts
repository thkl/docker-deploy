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

export class DeploymentStore {
    constructor(private readonly deploymentPath = join("./data", "deployments.json")) {}

    list(projectName: string) {
        return this.readData()[projectName] ?? [];
    }

    latest(projectName: string) {
        return this.list(projectName).at(-1) ?? null;
    }

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

    append(projectName: string, deploymentId: string, stream: DeploymentStream, chunk: string) {
        this.updateRecord(projectName, deploymentId, (record) => {
            const prefix = stream === "stderr" ? "[stderr] " : "";
            record.log = trimLog(`${record.log}${prefix}${chunk}`);
        });
    }

    finish(projectName: string, deploymentId: string, status: Exclude<DeploymentStatus, "running">, details?: { error?: string; exitCode?: number | string }) {
        this.updateRecord(projectName, deploymentId, (record) => {
            record.status = status;
            record.finishedAt = new Date().toISOString();
            record.error = details?.error;
            record.exitCode = details?.exitCode;
        });
    }

    private updateRecord(projectName: string, deploymentId: string, updater: (record: DeploymentRecord) => void) {
        const data = this.readData();
        const record = (data[projectName] ?? []).find((candidate) => candidate.id === deploymentId);

        if (!record) {
            return;
        }

        updater(record);
        this.writeData(data);
    }

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

    private writeData(data: DeploymentData) {
        mkdirSync(dirname(this.deploymentPath), { recursive: true });
        writeFileSync(this.deploymentPath, `${JSON.stringify(data, null, 2)}\n`);
    }
}

function trimLog(log: string) {
    if (log.length <= maxLogLength) {
        return log;
    }

    return `... log trimmed to last ${maxLogLength} characters ...\n${log.slice(-maxLogLength)}`;
}
