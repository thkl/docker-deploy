import { exec } from "node:child_process";
import { defaultProjectPath } from "./globalSettingsStore.js";
import { GlobalSettings, ProjectSettings } from "./types.js";
import { renderTraefikOverrideScript } from "./traefik.js";

export interface DeploymentHooks {
    onOutput?: (stream: "stdout" | "stderr", chunk: string) => void;
    onSuccess?: () => void;
    onFailure?: (error: Error & { code?: number | string }) => void;
}

function shellQuote(value: string | number | boolean) {
    return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

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

function renderCleanupScript(globalSettings: GlobalSettings) {
    if (!globalSettings.cleanupAfterDeploy) {
        return "";
    }

    return `
                    echo "--> Cleanup is enabled. Leaving compose artifacts in place; repository cleanup is not active yet."`;
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
