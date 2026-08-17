import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { AppDatabase, ControllerStateBackup } from "./database.js";
import type { GlobalSettingsStore } from "./globalSettingsStore.js";

const minuteMs = 60_000;

/**
 * Periodically writes the same controller-state JSON as the manual backup
 * endpoint. The scheduler reloads global settings on every tick, so changing
 * the cron expression does not require a controller restart.
 */
export class ConfigAutoBackupService {
    private timer: NodeJS.Timeout | undefined;
    private lastRunKey = "";

    constructor(
        private readonly database: AppDatabase,
        private readonly globalSettingsStore: GlobalSettingsStore
    ) {}

    start() {
        this.stop();
        this.tick();
        this.timer = setInterval(() => this.tick(), 30_000);
    }

    stop() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = undefined;
        }
    }

    private tick() {
        let settings;
        try {
            settings = this.globalSettingsStore.readSettings();
        } catch (error) {
            console.error(`Auto config backup skipped: ${error instanceof Error ? error.message : "could not read settings"}`);
            return;
        }

        if (!settings.autoBackupEnabled) {
            return;
        }

        const now = new Date();
        const runKey = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}-${now.getHours()}-${now.getMinutes()}`;
        if (runKey === this.lastRunKey || !cronMatches(settings.autoBackupCron, now)) {
            return;
        }

        this.lastRunKey = runKey;
        try {
            const result = writeControllerBackup(this.database.exportBackup(), settings.autoBackupPath);
            console.log(`Auto config backup written to ${result.path}`);
        } catch (error) {
            console.error(`Auto config backup failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
}

export function writeControllerBackup(backup: ControllerStateBackup, directory: string) {
    const createdAt = backup.createdAt.replace(/[:.]/g, "-");
    const backupPath = join(directory, `deploy-backup-${createdAt}.json`);
    const temporaryPath = `${backupPath}.tmp`;
    mkdirSync(dirname(backupPath), { recursive: true });
    writeFileSync(temporaryPath, `${JSON.stringify(backup, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporaryPath, backupPath);
    return { path: backupPath, createdAt: backup.createdAt };
}

export function cronMatches(expression: string, date: Date) {
    const fields = expression.trim().split(/\s+/);
    if (fields.length !== 5) {
        return false;
    }

    const [minute, hour, dayOfMonth, month, dayOfWeek] = fields;
    const dayOfMonthMatches = matchesField(dayOfMonth, date.getDate(), 1, 31);
    const dayOfWeekMatches = matchesField(dayOfWeek, date.getDay(), 0, 7, date.getDay() === 0 ? [0, 7] : [date.getDay()]);
    const dayMatches = dayOfMonth === "*" || dayOfWeek === "*" ? dayOfMonthMatches && dayOfWeekMatches : dayOfMonthMatches || dayOfWeekMatches;

    return matchesField(minute, date.getMinutes(), 0, 59)
        && matchesField(hour, date.getHours(), 0, 23)
        && matchesField(month, date.getMonth() + 1, 1, 12)
        && dayMatches;
}

export function isValidCronExpression(expression: string) {
    const fields = expression.trim().split(/\s+/);
    if (fields.length !== 5) {
        return false;
    }

    const ranges: Array<[number, number]> = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];
    return fields.every((field, index) => {
        const range = ranges[index];
        return Boolean(range) && isValidCronField(field, range[0], range[1]);
    });
}

function matchesField(field: string, value: number, min: number, max: number, aliases = [value]) {
    return aliases.some((candidate) => expandCronField(field, min, max).has(candidate));
}

function isValidCronField(field: string, min: number, max: number) {
    try {
        return expandCronField(field, min, max).size > 0;
    } catch {
        return false;
    }
}

function expandCronField(field: string, min: number, max: number) {
    const values = new Set<number>();
    for (const part of field.split(",")) {
        if (!part) {
            throw new Error("empty cron field part");
        }

        const [rangePart, stepPart] = part.split("/");
        if (part.split("/").length > 2) {
            throw new Error("invalid cron step");
        }

        const step = stepPart ? parseInteger(stepPart, 1, max) : 1;
        const [start, end] = parseCronRange(rangePart, min, max);
        for (let value = start; value <= end; value += step) {
            values.add(value);
        }
    }
    return values;
}

function parseCronRange(part: string, min: number, max: number): [number, number] {
    if (part === "*") {
        return [min, max];
    }

    if (part.includes("-")) {
        const pieces = part.split("-");
        if (pieces.length !== 2) {
            throw new Error("invalid cron range");
        }
        const start = parseInteger(pieces[0], min, max);
        const end = parseInteger(pieces[1], min, max);
        if (start > end) {
            throw new Error("cron range start must be before end");
        }
        return [start, end];
    }

    const value = parseInteger(part, min, max);
    return [value, value];
}

function parseInteger(value: string, min: number, max: number) {
    if (!/^\d+$/.test(value)) {
        throw new Error("cron value must be numeric");
    }
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
        throw new Error("cron value out of range");
    }
    return parsed;
}
