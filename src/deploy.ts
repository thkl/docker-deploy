import { exec } from "node:child_process";
import { ProjectSettings } from "./types.js";
import { renderTraefikOverrideScript } from "./traefik.js";

function shellQuote(value: string | number | boolean) {
    return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

export function dispatchBuildWorker(repoName: string, appSettings: ProjectSettings) {
    const hostAppsPath = appSettings.path ?? `/root/docker-apps/${repoName}`;
    const traefikOverrideScript = renderTraefikOverrideScript(repoName, appSettings);
    const composeOverrideScript = renderComposeOverrideScript(appSettings);
    const quotedHostAppsPath = shellQuote(hostAppsPath);
    const quotedHostAppsVolume = shellQuote(`${hostAppsPath}:${hostAppsPath}`);

    console.log(`Spinning up Ephemeral Build Worker for ${repoName}...`);

    const dockerRunCommand = `docker run -i --rm \
            -v /var/run/docker.sock:/var/run/docker.sock \
            -v ${quotedHostAppsVolume} \
            -v ~/.ssh:/root/.ssh:ro \
            alpine:latest sh << 'EOF'
                apk add --no-cache docker-cli docker-cli-compose docker-cli-buildx git openssh-client > /dev/null 2>&1

                cd ${quotedHostAppsPath}
                echo "--> Fetching latest changes..."
                git pull

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
                COMPOSE_FILES="-f $COMPOSE_FILE"
${composeOverrideScript}
${traefikOverrideScript}
                
                echo "--> Testing build for new changes..."
                docker compose $COMPOSE_FILES build
                if [ $? -eq 0 ]; then
                    echo "--> Build succeeded! Safely dropping old container via compose..."
                    docker compose $COMPOSE_FILES down
                    
                    echo "--> Starting newly built container..."
                    docker compose $COMPOSE_FILES up -d --no-build
                    echo "--> Deployment successful."
                else
                    echo "--> CRITICAL: Build failed! Keeping the old container running."
                    exit 1
                fi
EOF`;

    exec(dockerRunCommand, (error, stdout, stderr) => {
        if (error) {
            console.error(`Deployment Aborted: ${error.message}`);
            if (stderr) console.error(`Worker Inner Error (stderr):\n${stderr}`);
            if (stdout) console.log(`Worker Partial Output (stdout):\n${stdout}`);
            return;
        }
        console.log(`Worker output:\n${stdout}`);
    });
}

function renderComposeOverrideScript(appSettings: ProjectSettings) {
    const composeOverride = appSettings.composeOverride?.trim();
    if (!composeOverride) {
        return "";
    }

    return `
                echo "--> Writing stored Docker Compose override..."
                cat > docker-compose.updater.yml << 'UPDATER_COMPOSE_EOF'
${composeOverride}
UPDATER_COMPOSE_EOF
                COMPOSE_FILES="$COMPOSE_FILES -f docker-compose.updater.yml"`;
}
