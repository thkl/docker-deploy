import { exec } from "node:child_process";
import { isAbsolute, relative, resolve } from "node:path/posix";
import { promisify } from "node:util";
import { defaultProjectPath } from "./globalSettingsStore.js";
import { ComposeInspection, ComposeMountInspection, ComposePortInspection, ComposeResourceInspection, ComposeServiceInspection, ComposeStorageMapping, GlobalSettings, ProjectSettings } from "./types.js";
import { renderProjectRootEnvFileScript } from "./workerScripts.js";

const execAsync = promisify(exec);
const composeFileNames = ["docker-compose.yaml", "docker-compose.yml", "compose.yaml", "compose.yml"];
const composeFileMarker = "__UPDATER_COMPOSE_FILE__";
const composeJsonBeginMarker = "__UPDATER_COMPOSE_JSON_BEGIN__";
const composeJsonEndMarker = "__UPDATER_COMPOSE_JSON_END__";

/**
 * Inspects the effective Docker Compose model for a project on the target host.
 */
export async function inspectCompose(projectName: string, appSettings: ProjectSettings, globalSettings: GlobalSettings): Promise<ComposeInspection> {
    const composeOverride = appSettings.composeOverride?.trim();
    const projectRoot = appSettings.path ?? defaultProjectPath(globalSettings, projectName);
    const projectPath = `${projectRoot.replace(/\/+$/, "")}/.updater/inspect`;
    const output = composeOverride
        ? await inspectStoredOverride(projectName, appSettings, globalSettings, composeOverride)
        : await inspectRepositoryCompose(projectName, appSettings, globalSettings);
    return normalizeComposeInspection(output, composeOverride ? "storedOverride" : "repository", projectName, globalSettings, projectPath);
}

async function inspectStoredOverride(projectName: string, appSettings: ProjectSettings, globalSettings: GlobalSettings, composeOverride: string) {
    const projectRoot = appSettings.path ?? defaultProjectPath(globalSettings, projectName);
    const quotedProjectVolume = shellQuote(`${projectRoot}:${projectRoot}`);
    const quotedSshKeyPath = shellQuote(`${resolveHostPath(globalSettings.sshKeyPath)}:/root/.ssh:ro`);
    const quotedProjectRoot = shellQuote(projectRoot);
    const quotedRepositoryUrl = appSettings.repositoryUrl ? shellQuote(appSettings.repositoryUrl) : "";
    const projectRootEnvFileScript = renderProjectRootEnvFileScript();

    const dockerRunCommand = `docker run -i --rm \
            -v ${quotedProjectVolume} \
            -v ${quotedSshKeyPath} \
            alpine:latest sh << 'EOF'
                apk add --no-cache docker-cli docker-cli-compose git openssh-client > /dev/null 2>&1

                PROJECT_ROOT=${quotedProjectRoot}
                TMP_DEPLOY="$PROJECT_ROOT/.updater/inspect"
                mkdir -p "$PROJECT_ROOT/.updater"

                if [ -n "${quotedRepositoryUrl}" ]; then
                    rm -rf "$TMP_DEPLOY"
                    git clone ${quotedRepositoryUrl} "$TMP_DEPLOY"
                    cd "$TMP_DEPLOY"
                elif [ -d "$PROJECT_ROOT/.git" ]; then
                    echo "--> Using legacy project-root Git checkout for compose inspection..."
                    cd "$PROJECT_ROOT"
                else
                    mkdir -p "$TMP_DEPLOY"
                    cd "$TMP_DEPLOY"
                fi

                cat > docker-compose.updater.yml << 'UPDATER_COMPOSE_EOF'
${composeOverride}
UPDATER_COMPOSE_EOF
${projectRootEnvFileScript}
                echo "${composeFileMarker}docker-compose.updater.yml"
                echo "${composeJsonBeginMarker}"
                docker compose -f docker-compose.updater.yml config --format json
                echo "${composeJsonEndMarker}"
EOF`;

    const { stdout, stderr } = await execAsync(dockerRunCommand, { maxBuffer: 8 * 1024 * 1024 });
    if (stderr) {
        console.log(`[compose-inspect] override worker stderr:\n${stderr}`);
    }
    return stdout;
}

async function inspectRepositoryCompose(projectName: string, appSettings: ProjectSettings, globalSettings: GlobalSettings) {
    const projectRoot = appSettings.path ?? defaultProjectPath(globalSettings, projectName);
    const quotedProjectVolume = shellQuote(`${projectRoot}:${projectRoot}`);
    const quotedSshKeyPath = shellQuote(`${resolveHostPath(globalSettings.sshKeyPath)}:/root/.ssh:ro`);
    const quotedProjectRoot = shellQuote(projectRoot);
    const quotedRepositoryUrl = appSettings.repositoryUrl ? shellQuote(appSettings.repositoryUrl) : "";
    const composeSearch = composeFileNames.map(shellQuote).join(" ");
    const projectRootEnvFileScript = renderProjectRootEnvFileScript();

    const dockerRunCommand = `docker run -i --rm \
            -v ${quotedProjectVolume} \
            -v ${quotedSshKeyPath} \
            alpine:latest sh << 'EOF'
                apk add --no-cache docker-cli docker-cli-compose git openssh-client > /dev/null 2>&1

                PROJECT_ROOT=${quotedProjectRoot}
                TMP_DEPLOY="$PROJECT_ROOT/.updater/inspect"
                mkdir -p "$PROJECT_ROOT/.updater"

                if [ -n "${quotedRepositoryUrl}" ]; then
                    rm -rf "$TMP_DEPLOY"
                    git clone ${quotedRepositoryUrl} "$TMP_DEPLOY"
                    cd "$TMP_DEPLOY"
                elif [ -d "$PROJECT_ROOT/.git" ]; then
                    echo "--> Using legacy project-root Git checkout for compose inspection..."
                    cd "$PROJECT_ROOT"
                    echo "--> Fetching latest changes for compose inspection..."
                    git pull --ff-only
                else
                    if [ -z "${quotedRepositoryUrl}" ]; then
                        echo "--> CRITICAL: Project folder is missing or is not a Git checkout, and no repository URL is configured."
                        exit 1
                    fi
                fi

                COMPOSE_FILE=""
                for CANDIDATE in ${composeSearch}; do
                    if [ -f "$CANDIDATE" ]; then
                        COMPOSE_FILE="$CANDIDATE"
                        break
                    fi
                done

                if [ -z "$COMPOSE_FILE" ]; then
                    echo "--> CRITICAL: No Docker Compose file found in the repository."
                    exit 1
                fi

${projectRootEnvFileScript}
                echo "${composeFileMarker}$COMPOSE_FILE"
                echo "${composeJsonBeginMarker}"
                docker compose -f "$COMPOSE_FILE" config --format json
                echo "${composeJsonEndMarker}"
EOF`;

    const { stdout, stderr } = await execAsync(dockerRunCommand, { maxBuffer: 8 * 1024 * 1024 });
    if (stderr) {
        console.log(`[compose-inspect] repository worker stderr:\n${stderr}`);
    }
    return stdout;
}

function normalizeComposeInspection(output: string, source: ComposeInspection["source"], projectName: string, globalSettings: GlobalSettings, projectPath: string): ComposeInspection {
    const composeFile = parseMarkerValue(output, composeFileMarker);
    const config = parseMarkedJson(output) as ComposeConfig;
    const services = Object.entries(config.services ?? {}).map(([name, service]) => normalizeService(name, service, projectPath));
    const volumes = normalizeResources(config.volumes);
    const networks = normalizeResources(config.networks);
    const unsafeRelativeBindMounts = services.flatMap((service) => service.mounts).filter((mount) => !mount.safeForCleanup).length;
    const storageMappings = buildStorageMappings(projectName, globalSettings, services, projectPath);
    const storageOverridePreview = renderStorageOverridePreview(storageMappings);

    return {
        composeFile,
        source,
        checkedAt: new Date().toISOString(),
        services,
        networks,
        volumes,
        unsafeRelativeBindMounts,
        storageMappings,
        ...(storageOverridePreview ? { storageOverridePreview } : {})
    };
}

export function hasUnsafeRelativeBindMounts(inspection: ComposeInspection) {
    return inspection.storageMappings.length > 0 || inspection.unsafeRelativeBindMounts > 0;
}

export function countBindMountsInsidePath(inspection: ComposeInspection, path: string) {
    return inspection.services
        .flatMap((service) => service.mounts)
        .filter((mount) => mount.type === "bind" && mount.source && isCheckoutLocalPath(mount.source, path))
        .length;
}

function normalizeService(name: string, service: ComposeServiceConfig, projectPath: string): ComposeServiceInspection {
    return {
        name,
        ...(typeof service.image === "string" ? { image: service.image } : {}),
        ...(service.build ? { build: stringifyComposeValue(service.build) } : {}),
        ...(service.command ? { command: stringifyComposeValue(service.command) } : {}),
        ...(typeof service.restart === "string" ? { restart: service.restart } : {}),
        ports: normalizePorts(service.ports),
        expose: normalizeStringList(service.expose),
        mounts: normalizeMounts(service.volumes, projectPath),
        networks: normalizeNameList(service.networks),
        dependsOn: normalizeNameList(service.depends_on),
        environmentKeys: normalizeEnvironmentKeys(service.environment)
    };
}

function normalizePorts(ports: unknown): ComposePortInspection[] {
    if (!Array.isArray(ports)) {
        return [];
    }

    return ports.map((port) => {
        if (typeof port === "string" || typeof port === "number") {
            return { raw: String(port) };
        }

        if (isRecord(port)) {
            const normalized: ComposePortInspection = {
                raw: formatPort(port)
            };
            for (const key of ["target", "published", "protocol", "mode"] as const) {
                const value = port[key];
                if (value !== undefined && value !== null) {
                    normalized[key] = String(value);
                }
            }
            return normalized;
        }

        return { raw: stringifyComposeValue(port) };
    });
}

function normalizeMounts(volumes: unknown, projectPath: string): ComposeMountInspection[] {
    if (!Array.isArray(volumes)) {
        return [];
    }

    return volumes.map((volume) => {
        if (typeof volume === "string") {
            return normalizeStringMount(volume, projectPath);
        }

        if (isRecord(volume)) {
            const type = String(volume.type ?? "volume");
            const source = valueToString(volume.source);
            const target = valueToString(volume.target);
            const readOnly = Boolean(volume.read_only ?? volume.readonly);
            const relative = type === "bind" && Boolean(source) && isRelativePath(source);
            const checkoutLocal = type === "bind" && Boolean(source) && isCheckoutLocalPath(source, projectPath);
            return {
                type,
                ...(source ? { source } : {}),
                ...(target ? { target } : {}),
                readOnly,
                relative,
                safeForCleanup: !relative && !checkoutLocal,
                raw: stringifyComposeValue(volume)
            };
        }

        return {
            type: "unknown",
            readOnly: false,
            relative: false,
            safeForCleanup: true,
            raw: stringifyComposeValue(volume)
        };
    });
}

function normalizeStringMount(value: string, projectPath: string): ComposeMountInspection {
    const parts = value.split(":");
    const source = parts.length > 1 ? parts[0] : "";
    const target = parts.length > 1 ? parts[1] : parts[0];
    const flags = parts.slice(2);
    const relative = Boolean(source) && isRelativePath(source);
    const checkoutLocal = Boolean(source) && isCheckoutLocalPath(source, projectPath);

    return {
        type: source ? "bind" : "volume",
        ...(source ? { source } : {}),
        ...(target ? { target } : {}),
        readOnly: flags.includes("ro"),
        relative,
        safeForCleanup: !relative && !checkoutLocal,
        raw: value
    };
}

function normalizeResources(resources: unknown): ComposeResourceInspection[] {
    if (!isRecord(resources)) {
        return [];
    }

    return Object.entries(resources).map(([name, value]) => ({
        name,
        external: isRecord(value) ? Boolean(value.external) : false
    }));
}

function buildStorageMappings(projectName: string, globalSettings: GlobalSettings, services: ComposeServiceInspection[], projectPath: string): ComposeStorageMapping[] {
    return services.flatMap((service) =>
        service.mounts
            .filter((mount) => mount.type === "bind" && !mount.safeForCleanup && mount.source && mount.target)
            .map((mount) => {
                const suggestedHostPath = joinPaths(globalSettings.dataRoot, projectName, sanitizeMountSource(mount.source ?? "", projectPath));
                return {
                    service: service.name,
                    source: mount.source ?? "",
                    target: mount.target ?? "",
                    readOnly: mount.readOnly,
                    suggestedHostPath,
                    suggestedMount: `${suggestedHostPath}:${mount.target}${mount.readOnly ? ":ro" : ""}`
                };
            })
    );
}

function renderStorageOverridePreview(mappings: ComposeStorageMapping[]) {
    if (!mappings.length) {
        return "";
    }

    const serviceGroups = new Map<string, ComposeStorageMapping[]>();
    for (const mapping of mappings) {
        serviceGroups.set(mapping.service, [...(serviceGroups.get(mapping.service) ?? []), mapping]);
    }

    return [
        "services:",
        ...[...serviceGroups.entries()].flatMap(([service, serviceMappings]) => [
            `  ${yamlQuote(service)}:`,
            "    volumes:",
            ...serviceMappings.map((mapping) => `      - ${yamlQuote(mapping.suggestedMount)}`)
        ])
    ].join("\n");
}

function sanitizeRelativeMountSource(source: string) {
    const normalized = source
        .replace(/\\/g, "/")
        .replace(/^\.\/?/, "")
        .split("/")
        .filter(Boolean)
        .map((segment) => segment === ".." ? "up" : segment.replace(/[^a-zA-Z0-9._-]/g, "-"))
        .filter(Boolean)
        .join("/");

    return normalized || "root";
}

function joinPaths(...parts: string[]) {
    return parts
        .map((part, index) => index === 0 ? part.replace(/\/+$/, "") : part.replace(/^\/+|\/+$/g, ""))
        .filter(Boolean)
        .join("/");
}

function yamlQuote(value: string) {
    return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function normalizeNameList(value: unknown): string[] {
    if (Array.isArray(value)) {
        return value.map(String);
    }

    if (isRecord(value)) {
        return Object.keys(value);
    }

    return [];
}

function normalizeStringList(value: unknown): string[] {
    if (!Array.isArray(value)) {
        return [];
    }

    return value.map(String);
}

function normalizeEnvironmentKeys(value: unknown): string[] {
    if (Array.isArray(value)) {
        return value.map((entry) => String(entry).split("=").at(0) ?? "").filter(Boolean);
    }

    if (isRecord(value)) {
        return Object.keys(value);
    }

    return [];
}

function formatPort(port: Record<string, unknown>) {
    const target = valueToString(port.target);
    const published = valueToString(port.published);
    const protocol = valueToString(port.protocol) || "tcp";
    return published ? `${published}:${target}/${protocol}` : `${target}/${protocol}`;
}

function parseMarkerValue(output: string, marker: string) {
    const markerIndex = output.indexOf(marker);
    if (markerIndex < 0) {
        throw new Error("Compose inspection did not report a compose file.");
    }

    const value = output
        .slice(markerIndex + marker.length)
        .trim()
        .split(/\r?\n/)
        .at(0)
        ?.trim();

    if (!value) {
        throw new Error("Compose inspection reported an empty compose file.");
    }

    return value;
}

function parseMarkedJson(output: string) {
    const begin = output.indexOf(composeJsonBeginMarker);
    const end = output.indexOf(composeJsonEndMarker);
    if (begin < 0 || end < 0 || end < begin) {
        throw new Error("Could not parse Docker Compose inspection output.");
    }

    return JSON.parse(output.slice(begin + composeJsonBeginMarker.length, end).trim());
}

function isRelativePath(path: string) {
    return path === "." || path === ".." || path.startsWith("./") || path.startsWith("../");
}

function isCheckoutLocalPath(path: string, projectPath: string) {
    if (!isAbsolute(path)) {
        return false;
    }

    const relativeSource = relative(resolve(projectPath), resolve(path));
    return relativeSource === "" || (!relativeSource.startsWith("..") && !isAbsolute(relativeSource));
}

function sanitizeMountSource(source: string, projectPath: string) {
    if (isAbsolute(source) && isCheckoutLocalPath(source, projectPath)) {
        const sourceRelativeToProject = relative(resolve(projectPath), resolve(source));
        return sanitizeRelativeMountSource(sourceRelativeToProject || "root");
    }

    return sanitizeRelativeMountSource(source);
}

function valueToString(value: unknown) {
    return value === undefined || value === null ? "" : String(value);
}

function stringifyComposeValue(value: unknown) {
    return typeof value === "string" ? value : JSON.stringify(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function parentDirectory(path: string) {
    return path.replace(/\/+$/, "").replace(/\/[^/]+$/, "") || "/";
}

function shellQuote(value: string | number | boolean) {
    return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function resolveHostPath(value: string) {
    if (value === "~") {
        return process.env.HOME ?? value;
    }

    if (value.startsWith("~/")) {
        return `${process.env.HOME ?? "~"}${value.slice(1)}`;
    }

    return value;
}

interface ComposeConfig {
    services?: Record<string, ComposeServiceConfig>;
    networks?: Record<string, unknown>;
    volumes?: Record<string, unknown>;
}

interface ComposeServiceConfig {
    image?: unknown;
    build?: unknown;
    command?: unknown;
    restart?: unknown;
    ports?: unknown;
    expose?: unknown;
    volumes?: unknown;
    networks?: unknown;
    depends_on?: unknown;
    environment?: unknown;
}
