import { exec } from "node:child_process";
import { basename } from "node:path";
import { promisify } from "node:util";
import { defaultProjectPath } from "./globalSettingsStore.js";
import { renderTraefikOverrideScript } from "./traefik.js";
import { ComposeValidation, GlobalSettings, ProjectSettings } from "./types.js";
import { renderEnvFileVolume, renderProjectRootEnvFileScript, renderProjectRootStorageOverlayScript, renderTempBuildContextRewriteScript } from "./workerScripts.js";

const execAsync = promisify(exec);
const composeFileNames = ["docker-compose.yaml", "docker-compose.yml", "compose.yaml", "compose.yml"];
const composeFileMarker = "__UPDATER_COMPOSE_FILE__";
const composeSourceMarker = "__UPDATER_COMPOSE_SOURCE__";
const composeYamlBeginMarker = "__UPDATER_COMPOSE_YAML_BEGIN__";
const composeYamlEndMarker = "__UPDATER_COMPOSE_YAML_END__";
const composeWarningsBeginMarker = "__UPDATER_COMPOSE_WARNINGS_BEGIN__";
const composeWarningsEndMarker = "__UPDATER_COMPOSE_WARNINGS_END__";

/**
 * Validates the same effective Compose input that deployment will use.
 */
export async function validateCompose(projectName: string, appSettings: ProjectSettings, globalSettings: GlobalSettings): Promise<ComposeValidation> {
    const checkedAt = new Date().toISOString();
    const composeOverride = appSettings.composeOverride?.trim();
    const projectRoot = appSettings.path ?? defaultProjectPath(globalSettings, projectName);
    const composeProjectName = basename(projectRoot.replace(/\/+$/, "")) || projectName;
    const quotedProjectVolume = shellQuote(`${projectRoot}:${projectRoot}`);
    const quotedSshKeyPath = shellQuote(`${resolveHostPath(globalSettings.sshKeyPath)}:/root/.ssh:ro`);
    const quotedProjectRoot = shellQuote(projectRoot);
    const envFileVolume = renderEnvFileVolume(appSettings.envFilePath, projectRoot);
    const envFileVolumeMount = envFileVolume ? `            -v ${shellQuote(envFileVolume)} \\\n` : "";
    const quotedRepositoryUrl = appSettings.repositoryUrl ? shellQuote(appSettings.repositoryUrl) : "";
    const composeSearch = composeFileNames.map(shellQuote).join(" ");
    const composeOverrideScript = renderComposeOverrideScript(composeOverride);
    const composeSelectionScript = renderComposeSelectionScript(Boolean(composeOverride), composeSearch);
    const projectRootEnvFileScript = renderProjectRootEnvFileScript(appSettings.envFilePath);
    const tempBuildContextRewriteScript = renderTempBuildContextRewriteScript();
    const projectRootStorageOverlayScript = renderProjectRootStorageOverlayScript();
    const traefikOverrideScript = renderTraefikOverrideScript(projectName, appSettings, globalSettings);

    const dockerRunCommand = `docker run -i --rm \
            -v /var/run/docker.sock:/var/run/docker.sock \
            -v ${quotedProjectVolume} \
${envFileVolumeMount}            -v ${quotedSshKeyPath} \
            node:24.16.0-alpine sh << 'EOF'
                apk add --no-cache docker-cli docker-cli-compose git openssh-client > /dev/null 2>&1

                PROJECT_ROOT=${quotedProjectRoot}
                PROJECT_NAME=${shellQuote(composeProjectName)}
                COMPOSE_PROJECT_NAME="$PROJECT_NAME"
                TMP_DEPLOY="$PROJECT_ROOT/.updater/inspect"
                COMPOSE_WORKSPACE="$PROJECT_ROOT/.updater/compose"
                mkdir -p "$COMPOSE_WORKSPACE"
                cleanup_inspect() {
                    cd /
                    rm -rf "$TMP_DEPLOY"
                }
                trap cleanup_inspect EXIT

                if [ -n "${quotedRepositoryUrl}" ]; then
                    rm -rf "$TMP_DEPLOY"
                    git clone ${quotedRepositoryUrl} "$TMP_DEPLOY"
                    cd "$TMP_DEPLOY"
                elif [ -d "$PROJECT_ROOT/.git" ]; then
                    echo "--> Using legacy project-root Git checkout for compose validation..."
                    cd "$PROJECT_ROOT"
                    echo "--> Fetching latest changes for compose validation..."
                    git pull --ff-only
                else
                    mkdir -p "$TMP_DEPLOY"
                    cd "$TMP_DEPLOY"
                fi

${composeOverrideScript}
${tempBuildContextRewriteScript}
${composeSelectionScript}
${projectRootEnvFileScript}
${projectRootStorageOverlayScript}
${traefikOverrideScript}

                echo "${composeFileMarker}$COMPOSE_FILES"
                echo "${composeSourceMarker}${composeOverride ? "storedOverride" : "repository"}"
                if docker compose $COMPOSE_FILES config --no-interpolate > /tmp/updater-compose-effective.yml 2> /tmp/updater-compose-error.txt; then
                    echo "${composeYamlBeginMarker}"
                    cat /tmp/updater-compose-effective.yml
                    echo "${composeYamlEndMarker}"
                    echo "${composeWarningsBeginMarker}"
                    docker compose $COMPOSE_FILES config --format json > /tmp/updater-compose.json 2> /tmp/updater-compose-json-error.txt
                    node - /tmp/updater-compose.json << 'DEPLOY_EXTERNAL_NETWORKS_JS' | while read -r NETWORK_NAME; do
const fs = require("node:fs");

const data = JSON.parse(fs.readFileSync(process.argv[2], "utf8") || "{}");
const networks = data && typeof data === "object" && data.networks && typeof data.networks === "object" ? data.networks : {};
for (const [name, network] of Object.entries(networks)) {
  if (network && typeof network === "object" && network.external === true) {
    console.log(name);
  }
}
DEPLOY_EXTERNAL_NETWORKS_JS
                        if ! docker network inspect "$NETWORK_NAME" > /dev/null 2>&1; then
                            echo "External network $NETWORK_NAME does not exist on the target Docker host."
                        fi
                    done
                    if [ -s /tmp/updater-compose-json-error.txt ]; then
                        cat /tmp/updater-compose-json-error.txt
                    fi
                    echo "${composeWarningsEndMarker}"
                    exit 0
                fi

                cat /tmp/updater-compose-error.txt >&2
                exit 2
EOF`;

    try {
        const { stdout } = await execAsync(dockerRunCommand, { maxBuffer: 10 * 1024 * 1024 });
        return {
            valid: true,
            checkedAt,
            source: parseMarkerValue(stdout, composeSourceMarker) === "storedOverride" ? "storedOverride" : "repository",
            composeFile: parseMarkerValue(stdout, composeFileMarker),
            effectiveYaml: parseMarkedValue(stdout, composeYamlBeginMarker, composeYamlEndMarker),
            warnings: parseMarkedValue(stdout, composeWarningsBeginMarker, composeWarningsEndMarker)
                .split(/\r?\n/)
                .map((line) => line.trim())
                .filter(Boolean)
        };
    } catch (error) {
        const failure = error as { stdout?: string; stderr?: string; message?: string };
        const output = `${failure.stdout || ""}${failure.stderr ? `\n${failure.stderr}` : ""}`;
        return {
            valid: false,
            checkedAt,
            source: composeOverride ? "storedOverride" : "repository",
            composeFile: parseMarkerValue(output, composeFileMarker) || undefined,
            warnings: [],
            error: output.trim() || failure.message || "Docker Compose validation failed."
        };
    }
}

function renderComposeOverrideScript(composeOverride: string | undefined) {
    if (!composeOverride) {
        return "";
    }

    return `
                cat > docker-compose.updater.source.yml << 'UPDATER_COMPOSE_EOF'
${composeOverride}
UPDATER_COMPOSE_EOF
                cp docker-compose.updater.source.yml docker-compose.updater.yml`;
}

function renderComposeSelectionScript(hasComposeOverride: boolean, composeSearch: string) {
    if (hasComposeOverride) {
        return `
                COMPOSE_FILES="-f docker-compose.updater.yml"`;
    }

    return `
                COMPOSE_FILE=""
                for CANDIDATE in ${composeSearch}; do
                    if [ -f "$CANDIDATE" ]; then
                        COMPOSE_FILE="$CANDIDATE"
                        break
                    fi
                done
                if [ -z "$COMPOSE_FILE" ]; then
                    echo "--> CRITICAL: No Docker Compose file found."
                    exit 1
                fi
                COMPOSE_FILES="-f $COMPOSE_FILE"`;
}

function parseMarkerValue(output: string, marker: string) {
    return output
        .split(/\r?\n/)
        .find((line) => line.startsWith(marker))
        ?.slice(marker.length)
        .trim() || "";
}

function parseMarkedValue(output: string, beginMarker: string, endMarker: string) {
    const begin = output.indexOf(beginMarker);
    const end = output.indexOf(endMarker);
    if (begin === -1 || end === -1 || end < begin) {
        return "";
    }

    return output.slice(begin + beginMarker.length, end).replace(/^\r?\n/, "").replace(/\r?\n$/, "");
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
