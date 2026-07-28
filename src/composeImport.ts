import { exec } from "node:child_process";
import { promisify } from "node:util";
import { defaultProjectPath } from "./globalSettingsStore.js";
import { GlobalSettings, ProjectSettings } from "./types.js";

const execAsync = promisify(exec);
const composeFileNames = ["docker-compose.yaml", "docker-compose.yml", "compose.yaml", "compose.yml"];
const composeFileMarker = "__UPDATER_COMPOSE_FILE__";
const composeBeginMarker = "__UPDATER_COMPOSE_BEGIN__";
const composeEndMarker = "__UPDATER_COMPOSE_END__";

/**
 * Docker Compose file content imported from a project checkout.
 */
export interface ImportedCompose {
    composeFile: string;
    compose: string;
}

/**
 * Ensures the repository exists on the Docker host and returns the first
 * supported Compose file found in the checkout.
 *
 * The controller may run in a container with a different `/root/docker-apps`
 * namespace than the Docker host. Running import through Docker keeps compose
 * import, deployment, and cleanup aligned on the same host checkout path.
 */
export async function importProjectCompose(repoName: string, appSettings: ProjectSettings, globalSettings: GlobalSettings): Promise<ImportedCompose> {
    const projectPath = appSettings.path ?? defaultProjectPath(globalSettings, repoName);
    const output = await runDockerHostComposeImport(projectPath, appSettings.repositoryUrl, globalSettings);
    return parseImportedCompose(output);
}

/**
 * Runs a short-lived Docker worker that clones/pulls the repository and prints
 * the selected Compose file between parseable markers.
 */
async function runDockerHostComposeImport(projectPath: string, repositoryUrl: string | undefined, globalSettings: GlobalSettings) {
    const parentPath = parentDirectory(projectPath);
    const quotedParentVolume = shellQuote(`${parentPath}:${parentPath}`);
    const quotedSshKeyPath = shellQuote(`${resolveHostPath(globalSettings.sshKeyPath)}:/root/.ssh:ro`);
    const quotedProjectPath = shellQuote(projectPath);
    const quotedRepositoryUrl = repositoryUrl ? shellQuote(repositoryUrl) : "";
    const composeSearch = composeFileNames.map(shellQuote).join(" ");

    console.log(`[compose-import] docker host import path: ${projectPath}`);
    console.log(`[compose-import] docker host import mount: ${parentPath}:${parentPath}`);

    const dockerRunCommand = `docker run -i --rm \
            -v ${quotedParentVolume} \
            -v ${quotedSshKeyPath} \
            alpine:latest sh << 'EOF'
                apk add --no-cache git openssh-client > /dev/null 2>&1

                if [ ! -d ${quotedProjectPath}/.git ]; then
                    if [ -z "${quotedRepositoryUrl}" ]; then
                        echo "--> CRITICAL: Project folder is missing or is not a Git checkout, and no repository URL is configured."
                        exit 1
                    fi

                    if [ -d ${quotedProjectPath} ] && [ -n "$(find ${quotedProjectPath} -mindepth 1 -maxdepth 1 | head -n 1)" ]; then
                        echo "--> CRITICAL: Project folder exists but is not an empty directory or a Git checkout."
                        exit 1
                    fi

                    echo "--> Cloning repository into project folder..."
                    mkdir -p "$(dirname ${quotedProjectPath})"
                    git clone ${quotedRepositoryUrl} ${quotedProjectPath}
                else
                    echo "--> Fetching latest changes for compose import..."
                    git -C ${quotedProjectPath} pull --ff-only
                fi

                cd ${quotedProjectPath}
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

                echo "${composeFileMarker}$COMPOSE_FILE"
                echo "${composeBeginMarker}"
                cat "$COMPOSE_FILE"
                echo
                echo "${composeEndMarker}"
EOF`;

    const { stdout, stderr } = await execAsync(dockerRunCommand, { maxBuffer: 8 * 1024 * 1024 });
    if (stderr) {
        console.log(`[compose-import] worker stderr:\n${stderr}`);
    }

    return stdout;
}

/**
 * Parses the compose import worker output into file name and compose content.
 */
function parseImportedCompose(output: string): ImportedCompose {
    const fileMarkerIndex = output.indexOf(composeFileMarker);
    const beginMarkerIndex = output.indexOf(composeBeginMarker);
    const endMarkerIndex = output.indexOf(composeEndMarker);

    if (fileMarkerIndex < 0 || beginMarkerIndex < 0 || endMarkerIndex < 0 || endMarkerIndex < beginMarkerIndex) {
        throw new Error("Could not parse Docker Compose import output.");
    }

    const composeFileLine = output
        .slice(fileMarkerIndex + composeFileMarker.length, beginMarkerIndex)
        .trim()
        .split(/\r?\n/)
        .at(0)
        ?.trim();

    if (!composeFileLine) {
        throw new Error("Docker Compose import did not report the selected compose file.");
    }

    const composeStart = beginMarkerIndex + composeBeginMarker.length;
    const compose = output
        .slice(composeStart, endMarkerIndex)
        .replace(/^\r?\n/, "")
        .replace(/\r?\n$/, "");

    return {
        composeFile: composeFileLine,
        compose
    };
}

/**
 * Returns the parent directory for an absolute checkout path.
 */
function parentDirectory(path: string) {
    return path.replace(/\/+$/, "").replace(/\/[^/]+$/, "") || "/";
}

/**
 * Quotes a value so it can be embedded safely in a POSIX shell command.
 */
function shellQuote(value: string | number | boolean) {
    return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/**
 * Expands `~` in host paths that are mounted into Docker workers.
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
