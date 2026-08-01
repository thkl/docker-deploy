import { ChildProcess, exec, spawn } from "node:child_process";
import { basename } from "node:path";
import { promisify } from "node:util";
import { defaultProjectPath } from "./globalSettingsStore.js";
import { GlobalSettings, ProjectSettings, RuntimeActionResult, RuntimeLogs, RuntimeServiceAction, RuntimeServiceStatus, RuntimeStatus, ServerCapabilities, TraefikDiagnosticCheck, TraefikDiagnostics } from "./types.js";
import { renderTraefikOverrideScript } from "./traefik.js";
import { renderPersistedEnvFileRewriteScript, renderProjectRootEnvFileScript } from "./workerScripts.js";

const execAsync = promisify(exec);

/**
 * Optional lifecycle callbacks for a deployment worker process.
 *
 * The controller uses these hooks to persist logs and status while the shell
 * worker is still running inside Docker.
 */
export interface DeploymentHooks {
    onOutput?: (stream: "stdout" | "stderr", chunk: string) => void;
    onSuccess?: () => void;
    onFailure?: (error: Error & { code?: number | string }) => void;
}

export interface RuntimeLogHooks {
    onOutput?: (stream: "stdout" | "stderr", chunk: string) => void;
    onClose?: () => void;
    onFailure?: (error: Error) => void;
}

export interface RuntimeLogStream {
    stop(): void;
}

/**
 * Quotes a value so it can be embedded safely in a POSIX shell command.
 */
function shellQuote(value: string | number | boolean) {
    return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/**
 * Starts the ephemeral Docker-based deployment worker for a project.
 *
 * The worker mounts the project checkout path and Docker socket, clones or
 * pulls the repository, writes the stored compose override when configured,
 * applies generated Traefik compose labels, builds, replaces containers, and
 * streams process output through the supplied hooks.
 */
export function dispatchBuildWorker(repoName: string, appSettings: ProjectSettings, globalSettings: GlobalSettings, hooks: DeploymentHooks = {}): RuntimeLogStream {
    const hostAppsPath = appSettings.path ?? defaultProjectPath(globalSettings, repoName);
    const composeProjectName = basename(hostAppsPath.replace(/\/+$/, "")) || repoName;
    const traefikOverrideScript = renderTraefikOverrideScript(repoName, appSettings, globalSettings);
    const composeOverride = appSettings.composeOverride?.trim();
    const composeOverrideScript = renderComposeOverrideScript(composeOverride);
    const composeSelectionScript = renderComposeSelectionScript(composeOverride);
    const projectRootEnvFileScript = renderProjectRootEnvFileScript();
    const persistedEnvFileRewriteScript = renderPersistedEnvFileRewriteScript('"$COMPOSE_WORKSPACE/docker-compose.deploy.yml"');
    const quotedHostAppsPath = shellQuote(hostAppsPath);
    const quotedHostAppsVolume = shellQuote(`${hostAppsPath}:${hostAppsPath}`);
    const quotedSshKeyPath = shellQuote(`${resolveHostPath(globalSettings.sshKeyPath)}:/root/.ssh:ro`);
    const quotedRepositoryUrl = appSettings.repositoryUrl ? shellQuote(appSettings.repositoryUrl) : "";

    console.log(`Spinning up Ephemeral Build Worker for ${repoName}...`);

    // Keep the deployment logic inside the worker so the host only needs Docker.
    const dockerRunCommand = `docker run -i --rm \
            -v /var/run/docker.sock:/var/run/docker.sock \
            -v ${quotedHostAppsVolume} \
            -v ${quotedSshKeyPath} \
            alpine:latest sh << 'EOF'
                apk add --no-cache docker-cli docker-cli-compose docker-cli-buildx git openssh-client > /dev/null 2>&1

                PROJECT_ROOT=${quotedHostAppsPath}
                PROJECT_NAME=${shellQuote(composeProjectName)}
                TMP_DEPLOY="$PROJECT_ROOT/.updater/tmpdeploy"
                COMPOSE_WORKSPACE="$PROJECT_ROOT/.updater/compose"
                mkdir -p "$COMPOSE_WORKSPACE"

                if [ -n "${quotedRepositoryUrl}" ]; then
                    echo "--> Preparing temporary deployment checkout..."
                    rm -rf "$TMP_DEPLOY"
                    git clone ${quotedRepositoryUrl} "$TMP_DEPLOY"
                    cd "$TMP_DEPLOY"
                elif [ -d "$PROJECT_ROOT/.git" ]; then
                    echo "--> Using legacy project-root Git checkout..."
                    cd "$PROJECT_ROOT"
                else
                    echo "--> CRITICAL: No repository URL is configured and no legacy Git checkout exists at $PROJECT_ROOT."
                    exit 1
                fi

                echo "--> Fetching latest changes..."
                git pull --ff-only

${composeOverrideScript}
${composeSelectionScript}
${projectRootEnvFileScript}
${traefikOverrideScript}

                echo "--> Rendering persistent Compose deployment file..."
                docker compose -p ${shellQuote(composeProjectName)} $COMPOSE_FILES config --no-interpolate > "$COMPOSE_WORKSPACE/docker-compose.deploy.yml"
${persistedEnvFileRewriteScript}
                COMPOSE_FILES="-f $COMPOSE_WORKSPACE/docker-compose.deploy.yml"
                
                echo "--> Testing build for new changes..."
                docker compose -p ${shellQuote(composeProjectName)} $COMPOSE_FILES build
                if [ $? -eq 0 ]; then
                    echo "--> Build succeeded! Safely dropping old container via compose..."
                    docker compose -p ${shellQuote(composeProjectName)} $COMPOSE_FILES down
                    
                    echo "--> Starting newly built container..."
                    docker compose -p ${shellQuote(composeProjectName)} $COMPOSE_FILES up -d --no-build
                    echo "--> Deployment successful."
                else
                    echo "--> CRITICAL: Build failed! Keeping the old container running."
                    exit 1
                fi
EOF`;
    
    const worker = exec(dockerRunCommand, { maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
        if (error) {
            console.error(`Deployment Aborted: ${error.message}`);
            if (stderr) console.error(`Worker Inner Error (stderr):\n${stderr}`);
            if (stdout) console.log(`Worker Partial Output (stdout):\n${stdout}`);
            hooks.onFailure?.(error);
            return;
        }
        console.log(`Worker output:\n${stdout}`);
        hooks.onSuccess?.();
    });

    worker.stdout?.on("data", (chunk: Buffer | string) => {
        hooks.onOutput?.("stdout", String(chunk));
    });

    worker.stderr?.on("data", (chunk: Buffer | string) => {
        hooks.onOutput?.("stderr", String(chunk));
    });

    return {
        stop() {
            if (!worker.killed) {
                worker.kill("SIGTERM");
                windowedKill(worker);
            }
        }
    };
}

/**
 * Runs `docker compose down` for a project using the same compose file selection
 * rules as a deployment.
 */
export async function stopProjectContainers(repoName: string, appSettings: ProjectSettings, globalSettings: GlobalSettings) {
    const hostAppsPath = appSettings.path ?? defaultProjectPath(globalSettings, repoName);
    const composeProjectName = basename(hostAppsPath.replace(/\/+$/, "")) || repoName;
    const traefikOverrideScript = renderTraefikOverrideScript(repoName, appSettings, globalSettings);
    const composeOverride = appSettings.composeOverride?.trim();
    const composeOverrideScript = renderComposeOverrideScript(composeOverride);
    const composeSelectionScript = renderComposeSelectionScript(composeOverride);
    const quotedHostAppsPath = shellQuote(hostAppsPath);
    const quotedHostAppsVolume = shellQuote(`${hostAppsPath}:${hostAppsPath}`);

    const dockerRunCommand = `docker run -i --rm \
            -v /var/run/docker.sock:/var/run/docker.sock \
            -v ${quotedHostAppsVolume} \
            alpine:latest sh << 'EOF'
                apk add --no-cache docker-cli docker-cli-compose > /dev/null 2>&1
                mkdir -p ${quotedHostAppsPath}
                PROJECT_ROOT=${quotedHostAppsPath}
                PROJECT_NAME=${shellQuote(composeProjectName)}
                COMPOSE_WORKSPACE="$PROJECT_ROOT/.updater/compose"

                if [ -f "$COMPOSE_WORKSPACE/docker-compose.deploy.yml" ]; then
                    echo "--> Using persisted updater Compose file."
                    COMPOSE_FILES="-f $COMPOSE_WORKSPACE/docker-compose.deploy.yml"
                else
                    cd "$PROJECT_ROOT"

${composeOverrideScript}
${composeSelectionScript}
${traefikOverrideScript}
                fi

                echo "--> Stopping project containers..."
                docker compose -p ${shellQuote(composeProjectName)} $COMPOSE_FILES down
EOF`;

    const { stdout, stderr } = await execAsync(dockerRunCommand, { maxBuffer: 8 * 1024 * 1024 });
    return `${stdout}${stderr ? `\n${stderr}` : ""}`.trim();
}

/**
 * Deletes a project checkout path from inside a short-lived Docker container.
 *
 * This is used as a fallback when the host Node process cannot remove files
 * because they were created by the root-owned deployment worker container.
 */
export async function deleteCheckoutPath(checkoutPath: string) {
    const parentPath = checkoutPath.replace(/\/+$/, "").replace(/\/[^/]+$/, "") || "/";
    const checkoutName = checkoutPath.replace(/\/+$/, "").split("/").at(-1);

    if (!checkoutName) {
        throw new Error("Checkout path must include a directory name.");
    }

    console.log(`[checkout-cleanup] docker fallback mount: ${parentPath}:${parentPath}`);
    console.log(`[checkout-cleanup] docker fallback target: ${parentPath}/${checkoutName}`);

    const dockerRunCommand = `docker run -i --rm \
            -v ${shellQuote(`${parentPath}:${parentPath}`)} \
            alpine:latest sh << 'EOF'
                echo "--> Docker host cleanup exists before delete: $(test -e ${shellQuote(`${parentPath}/${checkoutName}`)} && echo true || echo false)"
                rm -rf -- ${shellQuote(`${parentPath}/${checkoutName}`)}
                if [ -e ${shellQuote(`${parentPath}/${checkoutName}`)} ]; then
                    echo "--> CRITICAL: Docker host checkout path still exists after rm."
                    exit 1
                fi
                echo "--> Docker host cleanup verified path removed."
EOF`;

    const { stdout, stderr } = await execAsync(dockerRunCommand, { maxBuffer: 8 * 1024 * 1024 });
    return `${stdout}${stderr ? `\n${stderr}` : ""}`.trim();
}

/**
 * Checks whether the target Docker server appears to have Traefik available.
 */
export async function detectTraefik(globalSettings: GlobalSettings): Promise<ServerCapabilities["traefik"]> {
    const networkName = globalSettings.defaultTraefikNetwork || "proxy";
    const command = `CONTAINERS="$(docker ps -a --format '{{.Image}} {{.Names}} {{.Labels}}' | grep -Ei '(^|[ /])traefik(:| |,|$)|org.opencontainers.image.title=Traefik' | wc -l | tr -d ' ')"
NETWORK_PRESENT="$(docker network inspect ${shellQuote(networkName)} > /dev/null 2>&1 && echo true || echo false)"
printf '{"containerCount":%s,"networkPresent":%s}\\n' "$CONTAINERS" "$NETWORK_PRESENT"`;

    try {
        const { stdout } = await execAsync(command, { maxBuffer: 1024 * 1024 });
        const result = JSON.parse(stdout.trim().split(/\r?\n/).at(-1) || "{}") as { containerCount?: number; networkPresent?: boolean };
        const containerCount = Number(result.containerCount || 0);
        const networkPresent = Boolean(result.networkPresent);

        return {
            available: containerCount > 0 || networkPresent,
            containerCount,
            networkPresent,
            checkedAt: new Date().toISOString()
        };
    } catch (error) {
        return {
            available: false,
            containerCount: 0,
            networkPresent: false,
            checkedAt: new Date().toISOString()
        };
    }
}

/**
 * Inspects containers that Docker Compose created for one deployed project.
 */
export async function inspectProjectStatus(repoName: string, appSettings: ProjectSettings, globalSettings: GlobalSettings): Promise<RuntimeStatus> {
    const hostAppsPath = appSettings.path ?? defaultProjectPath(globalSettings, repoName);
    const composeProjectName = basename(hostAppsPath.replace(/\/+$/, "")) || repoName;

    try {
        const { stdout: idsOutput, stderr: idsError } = await execAsync(
            `docker ps -aq --filter ${shellQuote(`label=com.docker.compose.project=${composeProjectName}`)}`,
            { maxBuffer: 512 * 1024 }
        );
        if (idsError.trim()) {
            return runtimeError(idsError.trim());
        }

        const ids = idsOutput.split(/\s+/).map((id) => id.trim()).filter(Boolean);
        if (!ids.length) {
            return {
                status: "stopped",
                checkedAt: new Date().toISOString(),
                services: []
            };
        }

        const { stdout, stderr } = await execAsync(
            `docker inspect ${ids.map(shellQuote).join(" ")}`,
            { maxBuffer: 2 * 1024 * 1024 }
        );
        if (stderr.trim()) {
            return runtimeError(stderr.trim());
        }

        const services = (JSON.parse(stdout.trim()) as DockerInspectContainer[]).map(parseRuntimeService);

        return {
            status: summarizeRuntimeStatus(services),
            checkedAt: new Date().toISOString(),
            services
        };
    } catch (error) {
        return runtimeError(error instanceof Error ? error.message : "Could not inspect runtime status.");
    }
}

/**
 * Checks the common Traefik 504 failure points for one deployed project.
 */
export async function diagnoseProjectTraefik(repoName: string, appSettings: ProjectSettings, globalSettings: GlobalSettings): Promise<TraefikDiagnostics> {
    const checkedAt = new Date().toISOString();
    const traefik = appSettings.traefik;
    const serviceName = traefik?.service || repoName;
    const port = Number(traefik?.port || 80);
    const network = traefik?.network || globalSettings.defaultTraefikNetwork || "proxy";

    if (!traefik?.enabled) {
        return {
            status: "warn",
            checkedAt,
            checks: [{ key: "enabled", label: "Traefik enabled", status: "warn", detail: "Traefik is not enabled for this project." }]
        };
    }

    const hostAppsPath = appSettings.path ?? defaultProjectPath(globalSettings, repoName);
    const composeProjectName = basename(hostAppsPath.replace(/\/+$/, "")) || repoName;
    const url = `http://${serviceName}:${port}/`;
    const dockerRunCommand = `docker run -i --rm \
            -v /var/run/docker.sock:/var/run/docker.sock \
            alpine:latest sh << 'EOF'
                apk add --no-cache docker-cli > /dev/null 2>&1
                TRAEFIK_IDS="$(docker ps -q --filter label=org.opencontainers.image.title=Traefik)"
                if [ -z "$TRAEFIK_IDS" ]; then
                    TRAEFIK_IDS="$(docker ps --format '{{.ID}} {{.Image}} {{.Names}}' | grep -Ei '(^|[ /])traefik(:| |$)' | awk '{print $1}')"
                fi
                TARGET_ID="$(docker ps -q --filter ${shellQuote(`label=com.docker.compose.project=${composeProjectName}`)} --filter ${shellQuote(`label=com.docker.compose.service=${serviceName}`)} | head -n 1)"
                NETWORK_PRESENT="$(docker network inspect ${shellQuote(network)} > /dev/null 2>&1 && echo true || echo false)"
                TRAEFIK_ON_NETWORK=false
                TARGET_ON_NETWORK=false
                if [ -n "$TRAEFIK_IDS" ]; then
                    for id in $TRAEFIK_IDS; do
                        if docker inspect "$id" --format '{{json .NetworkSettings.Networks}}' | grep -q ${shellQuote(`"${network}"`)}; then
                            TRAEFIK_ON_NETWORK=true
                        fi
                    done
                fi
                if [ -n "$TARGET_ID" ]; then
                    if docker inspect "$TARGET_ID" --format '{{json .NetworkSettings.Networks}}' | grep -q ${shellQuote(`"${network}"`)}; then
                        TARGET_ON_NETWORK=true
                    fi
                fi
                REACHABLE=false
                REACH_EXIT=125
                REACH_OUTPUT=""
                if [ "$NETWORK_PRESENT" = "true" ]; then
                    REACH_OUTPUT="$(docker run --rm --network ${shellQuote(network)} alpine:latest wget -T 5 -qO- ${shellQuote(url)} >/dev/null 2>&1)"
                    REACH_EXIT=$?
                    if [ "$REACH_EXIT" -eq 0 ] || echo "$REACH_OUTPUT" | grep -Eiq 'server returned error|404|401|403|500'; then
                        REACHABLE=true
                    fi
                fi
                echo "traefikContainerCount=$(printf "%s\\n" "$TRAEFIK_IDS" | sed '/^$/d' | wc -l | tr -d ' ')"
                echo "targetPresent=$([ -n "$TARGET_ID" ] && echo true || echo false)"
                echo "networkPresent=$NETWORK_PRESENT"
                echo "traefikOnNetwork=$TRAEFIK_ON_NETWORK"
                echo "targetOnNetwork=$TARGET_ON_NETWORK"
                echo "reachable=$REACHABLE"
                echo "reachExit=$REACH_EXIT"
                printf "reachOutput=%s\\n" "$REACH_OUTPUT"
EOF`;

    try {
        const { stdout } = await execAsync(dockerRunCommand, { maxBuffer: 2 * 1024 * 1024 });
        const raw = parseKeyValueOutput(stdout);
        const traefikContainerCount = Number(raw.traefikContainerCount || 0);
        const networkPresent = outputFlag(raw.networkPresent);
        const traefikOnNetwork = outputFlag(raw.traefikOnNetwork);
        const targetPresent = outputFlag(raw.targetPresent);
        const targetOnNetwork = outputFlag(raw.targetOnNetwork);
        const reachable = outputFlag(raw.reachable);
        const checks: TraefikDiagnosticCheck[] = [
            {
                key: "traefik-container",
                label: "Traefik container",
                status: traefikContainerCount > 0 ? "pass" : "fail",
                detail: traefikContainerCount > 0 ? `${traefikContainerCount} Traefik container(s) found.` : "No running Traefik container was found."
            },
            {
                key: "network-present",
                label: "Docker network",
                status: networkPresent ? "pass" : "fail",
                detail: networkPresent ? `${network} exists.` : `${network} does not exist on the target Docker host.`
            },
            {
                key: "traefik-network",
                label: "Traefik network membership",
                status: traefikOnNetwork ? "pass" : "fail",
                detail: traefikOnNetwork ? `Traefik is attached to ${network}.` : `Traefik is not attached to ${network}.`
            },
            {
                key: "target-container",
                label: "Target service container",
                status: targetPresent ? "pass" : "fail",
                detail: targetPresent ? `${serviceName} is running in Compose project ${composeProjectName}.` : `${serviceName} was not found in Compose project ${composeProjectName}.`
            },
            {
                key: "target-network",
                label: "Target network membership",
                status: targetOnNetwork ? "pass" : "fail",
                detail: targetOnNetwork ? `${serviceName} is attached to ${network}.` : `${serviceName} is not attached to ${network}.`
            },
            {
                key: "target-reachability",
                label: "Backend reachability",
                status: reachable ? "pass" : "fail",
                detail: reachable ? `${url} responds from ${network}.` : `${url} is not reachable from ${network}${raw.reachOutput ? `: ${raw.reachOutput}` : "."}`
            }
        ];

        return {
            status: summarizeDiagnosticStatus(checks),
            checkedAt,
            hostname: traefik.hostname,
            service: serviceName,
            port,
            network,
            checks
        };
    } catch (error) {
        return {
            status: "fail",
            checkedAt,
            hostname: traefik.hostname,
            service: serviceName,
            port,
            network,
            checks: [],
            error: error instanceof Error ? error.message : "Could not diagnose Traefik."
        };
    }
}

/**
 * Reads recent runtime logs for one Compose service/container.
 */
export async function readRuntimeLogs(repoName: string, appSettings: ProjectSettings, globalSettings: GlobalSettings, service: string, tail: number): Promise<RuntimeLogs> {
    const safeTail = Math.min(Math.max(Math.trunc(tail) || 200, 10), 2000);
    const status = await inspectProjectStatus(repoName, appSettings, globalSettings);
    const match = status.services.find((candidate) => candidate.service === service || candidate.containerId === service || candidate.containerName === service);
    if (!match?.containerId) {
        throw new Error("Service container was not found.");
    }

    const dockerRunCommand = `docker run -i --rm \
            -v /var/run/docker.sock:/var/run/docker.sock \
            alpine:latest sh << 'EOF'
                apk add --no-cache docker-cli > /dev/null 2>&1
                docker logs --tail ${safeTail} ${shellQuote(match.containerId)}
EOF`;
    const { stdout, stderr } = await execAsync(dockerRunCommand, { maxBuffer: 4 * 1024 * 1024 });

    return {
        service: match.service,
        containerId: match.containerId,
        tail: safeTail,
        checkedAt: new Date().toISOString(),
        output: `${stdout}${stderr ? `\n${stderr}` : ""}`
    };
}

/**
 * Follows runtime logs for one Compose service/container until stopped.
 */
export async function followRuntimeLogs(repoName: string, appSettings: ProjectSettings, globalSettings: GlobalSettings, service: string, tail: number, hooks: RuntimeLogHooks = {}): Promise<RuntimeLogStream> {
    const safeTail = Math.min(Math.max(Math.trunc(tail) || 200, 10), 2000);
    const status = await inspectProjectStatus(repoName, appSettings, globalSettings);
    const match = status.services.find((candidate) => candidate.service === service || candidate.containerId === service || candidate.containerName === service);
    if (!match?.containerId) {
        throw new Error("Service container was not found.");
    }

    const worker = spawn("docker", [
        "run",
        "-i",
        "--rm",
        "-v",
        "/var/run/docker.sock:/var/run/docker.sock",
        "alpine:latest",
        "sh",
        "-c",
        `apk add --no-cache docker-cli > /dev/null 2>&1 && docker logs --follow --tail ${safeTail} ${shellQuote(match.containerId)}`
    ], { stdio: ["ignore", "pipe", "pipe"] });

    return wireRuntimeLogWorker(worker, hooks);
}

/**
 * Runs one service-level Docker Compose action for an already deployed project.
 */
export async function runRuntimeServiceAction(repoName: string, appSettings: ProjectSettings, globalSettings: GlobalSettings, service: string, action: RuntimeServiceAction): Promise<RuntimeActionResult> {
    const serviceName = normalizeRuntimeActionInput(service, action);
    const dockerRunCommand = renderRuntimeServiceActionCommand(repoName, appSettings, globalSettings, serviceName, action);
    const { stdout, stderr } = await execAsync(dockerRunCommand, { maxBuffer: 4 * 1024 * 1024 });
    return {
        service: serviceName,
        action,
        checkedAt: new Date().toISOString(),
        output: `${stdout}${stderr ? `\n${stderr}` : ""}`.trim()
    };
}

/**
 * Streams one service-level Docker Compose action as it runs.
 */
export function streamRuntimeServiceAction(repoName: string, appSettings: ProjectSettings, globalSettings: GlobalSettings, service: string, action: RuntimeServiceAction, hooks: RuntimeLogHooks = {}): RuntimeLogStream {
    const serviceName = normalizeRuntimeActionInput(service, action);
    const worker = spawn("sh", ["-c", renderRuntimeServiceActionCommand(repoName, appSettings, globalSettings, serviceName, action)], { stdio: ["ignore", "pipe", "pipe"] });
    return wireRuntimeLogWorker(worker, hooks);
}

function normalizeRuntimeActionInput(service: string, action: RuntimeServiceAction) {
    const serviceName = service.trim();
    if (!serviceName) {
        throw new Error("Service is required.");
    }

    if (!isRuntimeServiceAction(action)) {
        throw new Error("Unsupported runtime action.");
    }

    return serviceName;
}

function renderRuntimeServiceActionCommand(repoName: string, appSettings: ProjectSettings, globalSettings: GlobalSettings, serviceName: string, action: RuntimeServiceAction) {
    const hostAppsPath = appSettings.path ?? defaultProjectPath(globalSettings, repoName);
    const composeProjectName = basename(hostAppsPath.replace(/\/+$/, "")) || repoName;
    const projectPath = resolveHostPath(hostAppsPath);
    const composeOverride = appSettings.composeOverride?.trim();
    const composeOverrideScript = renderComposeOverrideScript(composeOverride);
    const composeSelectionScript = renderComposeSelectionScript(composeOverride);
    const traefikOverrideScript = renderTraefikOverrideScript(repoName, appSettings, globalSettings);
    const actionScript = renderRuntimeServiceActionScript(serviceName, action);

    return `docker run -i --rm \
            -v /var/run/docker.sock:/var/run/docker.sock \
            -v ${shellQuote(`${projectPath}:${projectPath}`)} \
            alpine:latest sh << 'EOF'
                apk add --no-cache docker-cli docker-cli-compose > /dev/null 2>&1
                PROJECT_ROOT=${shellQuote(projectPath)}
                PROJECT_NAME=${shellQuote(composeProjectName)}
                COMPOSE_WORKSPACE="$PROJECT_ROOT/.updater/compose"

                if [ -f "$COMPOSE_WORKSPACE/docker-compose.deploy.yml" ]; then
                    COMPOSE_FILES="-f $COMPOSE_WORKSPACE/docker-compose.deploy.yml"
                else
                    cd "$PROJECT_ROOT"
${composeOverrideScript}
${composeSelectionScript}
${traefikOverrideScript}
                fi
${actionScript}
EOF`;
}

/**
 * Builds the shell block that writes a stored Docker Compose override into the
 * project checkout before compose commands run.
 */
function renderComposeOverrideScript(composeOverride: string | undefined) {
    if (!composeOverride) {
        return "";
    }

    return `
                echo "--> Writing stored Docker Compose file..."
                cat > docker-compose.updater.source.yml << 'UPDATER_COMPOSE_EOF'
${composeOverride}
UPDATER_COMPOSE_EOF
                cp docker-compose.updater.source.yml docker-compose.updater.yml
                if [ -n "$COMPOSE_WORKSPACE" ]; then
                    cp docker-compose.updater.source.yml "$COMPOSE_WORKSPACE/docker-compose.updater.source.yml"
                fi`;
}

/**
 * Builds the shell block that chooses which Docker Compose file(s) to use.
 *
 * A stored override intentionally replaces repository compose files. Without an
 * override the worker searches common compose filenames in the checkout.
 */
function renderComposeSelectionScript(composeOverride: string | undefined) {
    if (composeOverride) {
        return `
                echo "--> Using stored Docker Compose file as deployment source."
                COMPOSE_FILES="-f docker-compose.updater.yml"`;
    }

    return `
                COMPOSE_FILE="docker-compose.yaml"
                if [ ! -f "$COMPOSE_FILE" ] && [ -f docker-compose.yml ]; then
                    COMPOSE_FILE="docker-compose.yml"
                fi
                if [ ! -f "$COMPOSE_FILE" ] && [ -f compose.yaml ]; then
                    COMPOSE_FILE="compose.yaml"
                fi
                if [ ! -f "$COMPOSE_FILE" ] && [ -f compose.yml ]; then
                    COMPOSE_FILE="compose.yml"
                fi
                if [ ! -f "$COMPOSE_FILE" ]; then
                    echo "--> CRITICAL: No Docker Compose file found."
                    exit 1
                fi
                echo "--> Using repository Docker Compose file: $COMPOSE_FILE"
                COMPOSE_FILES="-f $COMPOSE_FILE"`;
}

function renderRuntimeServiceActionScript(service: string, action: RuntimeServiceAction) {
    const quotedService = shellQuote(service);
    if (action === "restart") {
        return `
                echo "--> Restarting ${service}..."
                docker compose -p "$PROJECT_NAME" $COMPOSE_FILES restart ${quotedService}`;
    }

    if (action === "start") {
        return `
                echo "--> Starting ${service}..."
                docker compose -p "$PROJECT_NAME" $COMPOSE_FILES start ${quotedService}`;
    }

    if (action === "stop") {
        return `
                echo "--> Stopping ${service}..."
                docker compose -p "$PROJECT_NAME" $COMPOSE_FILES stop ${quotedService}`;
    }

    if (action === "recreate") {
        return `
                echo "--> Recreating ${service}..."
                docker compose -p "$PROJECT_NAME" $COMPOSE_FILES up -d --no-deps --force-recreate ${quotedService}`;
    }

    return `
                echo "--> Pulling image for ${service}..."
                docker compose -p "$PROJECT_NAME" $COMPOSE_FILES pull ${quotedService}`;
}

function isRuntimeServiceAction(value: string): value is RuntimeServiceAction {
    return ["restart", "start", "stop", "recreate", "pull"].includes(value);
}

/**
 * Expands `~` in host paths that are mounted into the worker container.
 */
function resolveHostPath(value: string) {
    if (value === "~") {
        return process.env.HOME ?? value;
    }

    if (value.startsWith("~/")) {
        return `${process.env.HOME ?? "~"}${value.slice(1)}`;
    }

    return value;
}

function wireRuntimeLogWorker(worker: ChildProcess, hooks: RuntimeLogHooks): RuntimeLogStream {
    let stopped = false;
    let failed = false;

    worker.stdout?.on("data", (chunk: Buffer | string) => hooks.onOutput?.("stdout", String(chunk)));
    worker.stderr?.on("data", (chunk: Buffer | string) => hooks.onOutput?.("stderr", String(chunk)));
    worker.on("error", (error) => {
        failed = true;
        hooks.onFailure?.(error);
    });
    worker.on("close", (code, signal) => {
        if (failed) {
            return;
        }

        if (!stopped && code && code !== 0) {
            hooks.onFailure?.(new Error(`Runtime log stream exited with code ${code}${signal ? ` (${signal})` : ""}.`));
            return;
        }

        hooks.onClose?.();
    });

    return {
        stop() {
            stopped = true;
            if (!worker.killed) {
                worker.kill("SIGTERM");
                windowedKill(worker);
            }
        }
    };
}

function windowedKill(worker: ChildProcess) {
    setTimeout(() => {
        if (worker.exitCode === null && worker.signalCode === null) {
            worker.kill("SIGKILL");
        }
    }, 1500).unref();
}

type DockerPortBindings = Record<string, Array<{ HostIp?: string; HostPort?: string }> | null>;

interface DockerInspectContainer {
    Id?: string;
    Name?: string;
    Config?: {
        Image?: string;
        Labels?: Record<string, string>;
        ExposedPorts?: Record<string, unknown>;
    };
    State?: {
        Status?: string;
        Health?: {
            Status?: string;
        };
    };
    HostConfig?: {
        NetworkMode?: string;
    };
    NetworkSettings?: {
        Ports?: DockerPortBindings;
        Networks?: Record<string, unknown>;
    };
}

function parseRuntimeService(container: DockerInspectContainer): RuntimeServiceStatus {
    const ports = formatPublishedPorts(container.NetworkSettings?.Ports);
    const exposedPorts = Object.keys(container.Config?.ExposedPorts ?? {});
    const networks = Object.keys(container.NetworkSettings?.Networks ?? {});
    const networkMode = container.HostConfig?.NetworkMode || "unknown";
    const containerName = container.Name?.replace(/^\/+/, "");

    return {
        service: container.Config?.Labels?.["com.docker.compose.service"] || containerName || container.Id || "unknown",
        ...(containerName ? { containerName } : {}),
        ...(container.Id ? { containerId: container.Id.slice(0, 12) } : {}),
        state: container.State?.Status || "unknown",
        ...(container.State?.Health?.Status ? { health: container.State.Health.Status } : {}),
        ...(container.Config?.Image ? { image: container.Config.Image } : {}),
        ...(ports ? { ports } : {}),
        networkMode,
        ...(networks.length ? { networks } : {}),
        ...(exposedPorts.length ? { exposedPorts } : {})
    };
}

function formatPublishedPorts(ports: DockerPortBindings | undefined) {
    return Object.entries(ports ?? {})
        .flatMap(([containerPort, bindings]) => {
            if (!bindings?.length) {
                return [];
            }

            return bindings.map((binding) => `${containerPort} -> ${binding.HostIp || "0.0.0.0"}:${binding.HostPort || ""}`);
        })
        .join(", ");
}

function summarizeRuntimeStatus(services: RuntimeServiceStatus[]) {
    if (services.length === 0) {
        return "unknown";
    }

    const running = services.filter((service) => service.state.toLowerCase() === "running").length;
    if (running === services.length) {
        return "running";
    }

    if (running === 0) {
        return "stopped";
    }

    return "partial";
}

function parseKeyValueOutput(output: string) {
    return Object.fromEntries(
        output
            .trim()
            .split(/\r?\n/)
            .map((line) => {
                const separator = line.indexOf("=");
                return separator === -1 ? ["", ""] : [line.slice(0, separator), line.slice(separator + 1)];
            })
            .filter(([key]) => key)
    ) as Record<string, string>;
}

function outputFlag(value: string | undefined) {
    return value === "true";
}

function summarizeDiagnosticStatus(checks: TraefikDiagnosticCheck[]) {
    if (checks.some((check) => check.status === "fail")) {
        return "fail";
    }

    if (checks.some((check) => check.status === "warn")) {
        return "warn";
    }

    return "pass";
}

function runtimeError(error: string): RuntimeStatus {
    return {
        status: "error",
        checkedAt: new Date().toISOString(),
        services: [],
        error
    };
}
