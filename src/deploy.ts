import { exec } from "node:child_process";
import { promisify } from "node:util";
import { defaultProjectPath } from "./globalSettingsStore.js";
import { GlobalSettings, ProjectSettings, ServerCapabilities } from "./types.js";
import { renderTraefikOverrideScript } from "./traefik.js";

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
export function dispatchBuildWorker(repoName: string, appSettings: ProjectSettings, globalSettings: GlobalSettings, hooks: DeploymentHooks = {}) {
    const hostAppsPath = appSettings.path ?? defaultProjectPath(globalSettings, repoName);
    const traefikOverrideScript = renderTraefikOverrideScript(repoName, appSettings, globalSettings);
    const composeOverride = appSettings.composeOverride?.trim();
    const composeOverrideScript = renderComposeOverrideScript(composeOverride);
    const composeSelectionScript = renderComposeSelectionScript(composeOverride);
    const cleanupScript = renderCleanupScript(globalSettings);
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

                if [ ! -d ${quotedHostAppsPath}/.git ]; then
                    if [ -z "${quotedRepositoryUrl}" ]; then
                        echo "--> CRITICAL: Project folder is missing or is not a Git checkout, and no repository URL is configured."
                        exit 1
                    fi

                    if [ -d ${quotedHostAppsPath} ] && [ -n "$(find ${quotedHostAppsPath} -mindepth 1 -maxdepth 1 | head -n 1)" ]; then
                        echo "--> CRITICAL: Project folder exists but is not an empty directory or a Git checkout."
                        exit 1
                    fi

                    echo "--> Cloning repository into project folder..."
                    mkdir -p "$(dirname ${quotedHostAppsPath})"
                    git clone ${quotedRepositoryUrl} ${quotedHostAppsPath}
                fi

                cd ${quotedHostAppsPath}
                echo "--> Fetching latest changes..."
                git pull --ff-only

${composeOverrideScript}
${composeSelectionScript}
${traefikOverrideScript}
                
                echo "--> Testing build for new changes..."
                docker compose $COMPOSE_FILES build
                if [ $? -eq 0 ]; then
                    echo "--> Build succeeded! Safely dropping old container via compose..."
                    docker compose $COMPOSE_FILES down
                    
                    echo "--> Starting newly built container..."
                    docker compose $COMPOSE_FILES up -d --no-build
                    echo "--> Deployment successful."
${cleanupScript}
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
}

/**
 * Runs `docker compose down` for a project using the same compose file selection
 * rules as a deployment.
 */
export async function stopProjectContainers(repoName: string, appSettings: ProjectSettings, globalSettings: GlobalSettings) {
    const hostAppsPath = appSettings.path ?? defaultProjectPath(globalSettings, repoName);
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
                cd ${quotedHostAppsPath}

${composeOverrideScript}
${composeSelectionScript}
${traefikOverrideScript}

                echo "--> Stopping project containers..."
                docker compose $COMPOSE_FILES down
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
    const dockerRunCommand = `docker run -i --rm \
            -v /var/run/docker.sock:/var/run/docker.sock \
            alpine:latest sh << 'EOF'
                apk add --no-cache docker-cli > /dev/null 2>&1
                CONTAINERS="$(docker ps -a --format '{{.Image}} {{.Names}} {{.Labels}}' | grep -Ei '(^|[ /])traefik(:| |,|$)|org.opencontainers.image.title=Traefik' | wc -l | tr -d ' ')"
                NETWORK_PRESENT="$(docker network inspect ${shellQuote(networkName)} > /dev/null 2>&1 && echo true || echo false)"
                printf '{"containerCount":%s,"networkPresent":%s}\\n' "$CONTAINERS" "$NETWORK_PRESENT"
EOF`;

    try {
        const { stdout } = await execAsync(dockerRunCommand, { maxBuffer: 1024 * 1024 });
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
 * Builds the shell block that writes a stored Docker Compose override into the
 * project checkout before compose commands run.
 */
function renderComposeOverrideScript(composeOverride: string | undefined) {
    if (!composeOverride) {
        return "";
    }

    return `
                echo "--> Writing stored Docker Compose file..."
                cat > docker-compose.updater.yml << 'UPDATER_COMPOSE_EOF'
${composeOverride}
UPDATER_COMPOSE_EOF`;
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

/**
 * Builds the deployment cleanup shell block.
 *
 * Cleanup is intentionally a placeholder for now because deleting repository
 * files can break bind mounts until data mapping is modeled explicitly.
 */
function renderCleanupScript(globalSettings: GlobalSettings) {
    if (!globalSettings.cleanupAfterDeploy) {
        return "";
    }

    return `
                    echo "--> Cleanup is enabled. Leaving compose artifacts in place; repository cleanup is not active yet."`;
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
