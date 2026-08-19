import { ChildProcess, exec, spawn } from "node:child_process";
import { basename } from "node:path";
import { promisify } from "node:util";
import { defaultProjectPath } from "./globalSettingsStore.js";
import { CapturedReleaseSnapshot, CheckoutBindMountInspection, DockerNetworkInventory, DockerTopology, GlobalSettings, ProjectEnvironmentSecret, ProjectReleaseSnapshot, ProjectSettings, RegistryLoginCheck, RuntimeActionResult, RuntimeLogs, RuntimeServiceAction, RuntimeServiceStatus, RuntimeStatus, ServerCapabilities, TraefikConfigApplyResult, TraefikConfigBackup, TraefikConfigBackupFile, TraefikConfigValidation, TraefikConfigValidationCheck, TraefikContainerInventory, TraefikDefaultsPayload, TraefikDiagnosticCheck, TraefikDiagnostics, TraefikDiagnosticStatus } from "./types.js";
import { renderTraefikOverrideScript } from "./traefik.js";
import { renderPersistedEnvFileRewriteScript, renderPersistedStorageGuardScript, renderPersistedStorageRewriteScript, renderProjectRootEnvFileScript, renderTempBuildContextRewriteScript } from "./workerScripts.js";

const execAsync = promisify(exec);

/**
 * Optional lifecycle callbacks for a deployment worker process.
 *
 * The controller uses these hooks to persist logs and status while the shell
 * worker is still running inside Docker.
 */
export interface DeploymentHooks {
    onAccepted?: (job: { jobId: string; streamToken: string }) => void;
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

const snapshotBeginMarker = "__DEPLOY_RELEASE_SNAPSHOT_BEGIN__";
const snapshotEndMarker = "__DEPLOY_RELEASE_SNAPSHOT_END__";

export async function inspectDockerTopology(): Promise<DockerTopology> {
    const checkedAt = new Date().toISOString();
    try {
        const { stdout } = await execAsync(
            "docker info --format '{{json .Swarm}}' 2>/dev/null",
            { maxBuffer: 128 * 1024 }
        );
        const swarm = JSON.parse(stdout.trim() || "{}") as {
            LocalNodeState?: string;
            ControlAvailable?: boolean;
            NodeID?: string;
        };
        const state = String(swarm.LocalNodeState || "").toLowerCase();
        const controlAvailable = Boolean(swarm.ControlAvailable);
        const mode: DockerTopology["mode"] = state === "active"
            ? controlAvailable ? "swarm-manager" : "swarm-worker"
            : state === "inactive"
                ? "swarm-inactive"
                : "standalone";

        return {
            checkedAt,
            available: true,
            mode,
            ...(swarm.LocalNodeState ? { swarmLocalNodeState: swarm.LocalNodeState } : {}),
            swarmControlAvailable: controlAvailable,
            ...(swarm.NodeID ? { nodeId: swarm.NodeID } : {})
        };
    } catch (error) {
        return {
            checkedAt,
            available: false,
            mode: "unknown",
            error: error instanceof Error ? error.message : "Could not inspect Docker topology."
        };
    }
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
    const deploymentStrategy = appSettings.deploymentStrategy === "swarm" ? "swarm" : "compose";
    const registry = appSettings.registry;
    const registryPublish = Boolean(registry?.publish);
    const registryDeployFromRegistry = Boolean(registry?.deployFromRegistry);
    const registryEnabled = registryPublish || registryDeployFromRegistry;
    const traefikOverrideScript = renderTraefikOverrideScript(repoName, appSettings, globalSettings);
    const composeOverride = appSettings.composeOverride?.trim();
    const composeOverrideScript = renderComposeOverrideScript(composeOverride);
    const composeSelectionScript = renderComposeSelectionScript(composeOverride);
    const secretOverlayScript = renderSecretComposeOverlayScript(appSettings.envSecrets);
    const projectRootEnvFileScript = renderProjectRootEnvFileScript();
    const tempBuildContextRewriteScript = renderTempBuildContextRewriteScript();
    const persistedEnvFileRewriteScript = renderPersistedEnvFileRewriteScript('"$COMPOSE_WORKSPACE/docker-compose.deploy.yml"');
    const persistedStorageRewriteScript = renderPersistedStorageRewriteScript('"$COMPOSE_WORKSPACE/docker-compose.deploy.yml"');
    const persistedStorageGuardScript = renderPersistedStorageGuardScript('"$COMPOSE_WORKSPACE/docker-compose.deploy.yml"');
    const registryRewriteScript = renderRegistryComposeRewriteScript();
    const registryStripBuildScript = renderRegistryStripBuildScript();
    const quotedHostAppsPath = shellQuote(hostAppsPath);
    const quotedRepositoryUrl = appSettings.repositoryUrl ? shellQuote(appSettings.repositoryUrl) : "";
    const registryAddress = globalSettings.registryAddress.trim();
    const registryUsername = globalSettings.registryUsername.trim();
    const registryPassword = globalSettings.registryPassword?.trim() ?? "";
    const registryImageNamespace = registry?.imageNamespace?.trim() || composeProjectName;
    const registryImageTag = registry?.imageTag?.trim() || "latest";

    console.log(`Spinning up Ephemeral Build Worker for ${repoName}...`);

    const workerScript = `
                apk add --no-cache docker-cli docker-cli-compose docker-cli-buildx git openssh-client > /dev/null 2>&1

                PROJECT_ROOT=${quotedHostAppsPath}
                PROJECT_ROOT="\${PROJECT_ROOT%/}"
                PROJECT_NAME=${shellQuote(composeProjectName)}
                DEPLOYMENT_STRATEGY=${shellQuote(deploymentStrategy)}
                REGISTRY_ENABLED=${shellQuote(registryEnabled ? "true" : "false")}
                REGISTRY_PUBLISH=${shellQuote(registryPublish ? "true" : "false")}
                REGISTRY_DEPLOY_FROM_REGISTRY=${shellQuote(registryDeployFromRegistry ? "true" : "false")}
                REGISTRY_ADDRESS=${shellQuote(registryAddress)}
                REGISTRY_USERNAME=${shellQuote(registryUsername)}
                REGISTRY_PASSWORD=${shellQuote(registryPassword)}
                REGISTRY_IMAGE_NAMESPACE=${shellQuote(registryImageNamespace)}
                REGISTRY_IMAGE_TAG=${shellQuote(registryImageTag)}
                TMP_DEPLOY="$PROJECT_ROOT/.updater/tmpdeploy"
                RELEASE_DEPLOY="$PROJECT_ROOT/.updater/release"
                COMPOSE_WORKSPACE="$PROJECT_ROOT/.updater/compose"
                mkdir -p "$COMPOSE_WORKSPACE"
                DEPLOY_ACTIVE_MARKER="$PROJECT_ROOT/.updater/deploy.active"
                date +%s > "$DEPLOY_ACTIVE_MARKER"
                cleanup_deploy_active_marker() {
                    rm -f "$DEPLOY_ACTIVE_MARKER"
                }
                trap cleanup_deploy_active_marker EXIT
                trap 'cleanup_deploy_active_marker; exit 130' INT
                trap 'cleanup_deploy_active_marker; exit 143' TERM

                if [ -n "${quotedRepositoryUrl}" ]; then
                    echo "--> Preparing temporary deployment checkout..."
                    rm -rf "$TMP_DEPLOY"
                    git clone ${quotedRepositoryUrl} "$TMP_DEPLOY"
                    cd "$TMP_DEPLOY"
                elif [ -d "$PROJECT_ROOT/.git" ]; then
                    echo "--> Using legacy project-root Git checkout..."
                    cd "$PROJECT_ROOT"
                elif [ -n ${shellQuote(composeOverride ? "true" : "")} ]; then
                    echo "--> No repository URL configured. Using stored Docker Compose file only."
                    mkdir -p "$PROJECT_ROOT"
                    cd "$PROJECT_ROOT"
                else
                    echo "--> CRITICAL: No repository URL is configured and no legacy Git checkout exists at $PROJECT_ROOT."
                    exit 1
                fi

                if [ -d .git ]; then
                    echo "--> Fetching latest changes..."
                    git pull --ff-only
                fi
                if [ "$PWD" = "$TMP_DEPLOY" ]; then
                    echo "--> Updating stable release checkout..."
                    rm -rf "$RELEASE_DEPLOY"
                    mkdir -p "$(dirname "$RELEASE_DEPLOY")"
                    cp -a "$TMP_DEPLOY" "$RELEASE_DEPLOY"
                fi

${composeOverrideScript}
${tempBuildContextRewriteScript}
${composeSelectionScript}
${projectRootEnvFileScript}
${traefikOverrideScript}
${secretOverlayScript}

                echo "--> Rendering persistent Compose deployment file..."
                docker compose -p ${shellQuote(composeProjectName)} $COMPOSE_FILES config --no-interpolate > "$COMPOSE_WORKSPACE/docker-compose.deploy.yml"
${persistedEnvFileRewriteScript}
${persistedStorageRewriteScript}
${persistedStorageGuardScript}
                cleanup_release_if_unused() {
                    if [ -d "$RELEASE_DEPLOY" ] && ! grep -F "$RELEASE_DEPLOY" "$COMPOSE_WORKSPACE/docker-compose.deploy.yml" > /dev/null 2>&1; then
                        echo "--> Removing unused stable release checkout."
                        rm -rf "$RELEASE_DEPLOY"
                    fi
                }
                cleanup_release_if_unused
                COMPOSE_FILES="-f $COMPOSE_WORKSPACE/docker-compose.deploy.yml"
                cd "$PROJECT_ROOT"

                if [ "$REGISTRY_ENABLED" = "true" ]; then
                    if [ -z "$REGISTRY_ADDRESS" ]; then
                        echo "--> CRITICAL: Registry deployment is enabled for this project, but no controller registry address is configured."
                        exit 1
                    fi

                    echo "--> Preparing registry image references..."
${registryRewriteScript}

                    if [ -n "$REGISTRY_USERNAME" ]; then
                        if [ -z "$REGISTRY_PASSWORD" ]; then
                            echo "--> CRITICAL: Registry username is configured, but the registry password is empty."
                            exit 1
                        fi
                        echo "--> Logging in to Docker registry $REGISTRY_ADDRESS..."
                        printf '%s' "$REGISTRY_PASSWORD" | docker login "$REGISTRY_ADDRESS" --username "$REGISTRY_USERNAME" --password-stdin >/dev/null
                    fi
                fi

                if [ "$REGISTRY_PUBLISH" = "true" ]; then
                    echo "--> Building registry-tagged images..."
                    REGISTRY_SERVICES="$(cat /tmp/deploy-registry-services 2>/dev/null || true)"
                    if [ -z "$REGISTRY_SERVICES" ]; then
                        echo "--> No build-backed services found to publish."
                    else
                    docker compose -p ${shellQuote(composeProjectName)} $COMPOSE_FILES build $REGISTRY_SERVICES
                    if [ $? -ne 0 ]; then
                        echo "--> CRITICAL: Registry image build failed."
                        exit 1
                    fi

                    echo "--> Pushing images to registry..."
                    docker compose -p ${shellQuote(composeProjectName)} $COMPOSE_FILES push $REGISTRY_SERVICES
                    if [ $? -ne 0 ]; then
                        echo "--> CRITICAL: Registry image push failed."
                        exit 1
                    fi
                    fi
                fi

                if [ "$REGISTRY_DEPLOY_FROM_REGISTRY" = "true" ]; then
                    echo "--> Switching Compose deployment file to registry images only..."
${registryStripBuildScript}
                    cleanup_release_if_unused
                fi

                if [ "$DEPLOYMENT_STRATEGY" = "swarm" ]; then
                    echo "--> Checking Swarm manager availability..."
                    if [ "$(docker info --format '{{.Swarm.ControlAvailable}}' 2>/dev/null || echo false)" != "true" ]; then
                        echo "--> CRITICAL: Swarm stack deployment must run on a Docker Swarm manager agent."
                        exit 1
                    fi

                    echo "--> Rendering Swarm stack source..."
                    docker compose -p ${shellQuote(composeProjectName)} $COMPOSE_FILES config --format json > /tmp/deploy-compose-stack.json

                    echo "--> Sanitizing Compose file for Swarm stack deployment..."
                    node - "$COMPOSE_WORKSPACE/docker-compose.deploy.yml" /tmp/deploy-compose-stack.json << 'DEPLOY_SWARM_SANITIZE_JS'
const fs = require("node:fs");

const outputPath = process.argv[2];
const inputPath = process.argv[3];
const data = JSON.parse(fs.readFileSync(inputPath, "utf8") || "{}");
const isObject = (value) => value && typeof value === "object" && !Array.isArray(value);
const isEmptyObject = (value) => isObject(value) && Object.keys(value).length === 0;

if (isObject(data)) {
  delete data.name;
}

for (const section of ["networks", "volumes"]) {
  const resources = isObject(data) ? data[section] : undefined;
  if (!isObject(resources)) {
    continue;
  }

  for (const resource of Object.values(resources)) {
    if (!isObject(resource)) {
      continue;
    }

    delete resource.name;
    for (const key of ["ipam", "driver_opts", "labels"]) {
      if (isEmptyObject(resource[key])) {
        delete resource[key];
      }
    }
  }
}

const services = isObject(data) ? data.services : undefined;
if (isObject(services)) {
  for (const service of Object.values(services)) {
    if (!isObject(service)) {
      continue;
    }

    for (const key of ["command", "entrypoint"]) {
      if (service[key] === null) {
        delete service[key];
      }
    }

    if (isObject(service.networks) && Object.values(service.networks).every((value) => value === null)) {
      service.networks = Object.keys(service.networks);
    }

    if (isObject(service.labels)) {
      for (const key of Object.keys(service.labels)) {
        if (key.startsWith("traefik.")) {
          delete service.labels[key];
        }
      }
      if (isEmptyObject(service.labels)) {
        delete service.labels;
      }
    } else if (Array.isArray(service.labels)) {
      service.labels = service.labels.filter((label) => !String(label).startsWith("traefik."));
      if (!service.labels.length) {
        delete service.labels;
      }
    }

    if (Array.isArray(service.volumes)) {
      for (const volume of service.volumes) {
        if (isObject(volume) && isEmptyObject(volume.volume)) {
          delete volume.volume;
        }
      }
    }

    const deploy = service.deploy;
    if (!isObject(deploy)) {
      continue;
    }

    if (isObject(deploy.labels)) {
      deploy.labels = Object.entries(deploy.labels).map(([key, value]) => String(key) + "=" + String(value));
    }

    if (isEmptyObject(deploy.resources)) {
      delete deploy.resources;
    }

    const constraints = isObject(deploy.placement) ? deploy.placement.constraints : undefined;
    if (Array.isArray(constraints)) {
      const seen = new Set();
      deploy.placement.constraints = constraints.filter((item) => {
        if (seen.has(item)) {
          return false;
        }
        seen.add(item);
        return true;
      });
    }
  }
}

fs.writeFileSync(outputPath, JSON.stringify(data, null, 2) + "\\n");
DEPLOY_SWARM_SANITIZE_JS

                    echo "--> Validating Swarm stack source..."
                    if node - /tmp/deploy-compose-stack.json << 'DEPLOY_SWARM_VALIDATE_JS'
const fs = require("node:fs");
const data = JSON.parse(fs.readFileSync(process.argv[2], "utf8") || "{}");
const services = data && typeof data === "object" && data.services && typeof data.services === "object" ? data.services : {};
const hasBuild = Object.values(services).some((service) => service && typeof service === "object" && service.build != null);
process.exit(hasBuild ? 0 : 1);
DEPLOY_SWARM_VALIDATE_JS
                    then
                        echo "--> CRITICAL: Swarm stack deployment requires image-based services. Remove build directives or publish images before deploying as a stack."
                        exit 1
                    fi

                    echo "--> Deploying Swarm stack..."
                    if [ "$REGISTRY_DEPLOY_FROM_REGISTRY" = "true" ]; then
                        docker stack deploy --with-registry-auth -c "$COMPOSE_WORKSPACE/docker-compose.deploy.yml" "$PROJECT_NAME"
                    else
                        docker stack deploy -c "$COMPOSE_WORKSPACE/docker-compose.deploy.yml" "$PROJECT_NAME"
                    fi
                    if [ $? -eq 0 ]; then
                        echo "--> Swarm stack deployment successful."
                    else
                        echo "--> CRITICAL: Swarm stack deploy failed."
                        exit 1
                    fi
                else
                    if [ "$REGISTRY_DEPLOY_FROM_REGISTRY" = "true" ]; then
                        echo "--> Pulling images from registry..."
                        REGISTRY_SERVICES="$(cat /tmp/deploy-registry-services 2>/dev/null || true)"
                        docker compose -p ${shellQuote(composeProjectName)} $COMPOSE_FILES pull $REGISTRY_SERVICES
                        if [ $? -ne 0 ]; then
                            echo "--> CRITICAL: Registry image pull failed."
                            exit 1
                        fi

                        echo "--> Recreating changed services from registry images..."
                        docker compose -p ${shellQuote(composeProjectName)} $COMPOSE_FILES up -d --no-build --remove-orphans
                        if [ $? -eq 0 ]; then
                            echo "--> Deployment successful."
                        else
                            echo "--> CRITICAL: Compose up failed after pulling registry images. Existing containers were not intentionally removed by Deploy."
                            exit 1
                        fi
                    else
                        echo "--> Testing build for new changes..."
                        docker compose -p ${shellQuote(composeProjectName)} $COMPOSE_FILES build
                        if [ $? -eq 0 ]; then
                            echo "--> Build succeeded! Recreating changed services via compose..."
                            docker compose -p ${shellQuote(composeProjectName)} $COMPOSE_FILES up -d --no-build --remove-orphans
                            if [ $? -eq 0 ]; then
                                echo "--> Deployment successful."
                            else
                                echo "--> CRITICAL: Compose up failed after a successful build. Existing containers were not intentionally removed by Deploy."
                                exit 1
                            fi
                        else
                            echo "--> CRITICAL: Build failed! Keeping the old container running."
                            exit 1
                        fi
                    fi
                fi`;
    
    const worker = spawn("docker", [
        "run",
        "-i",
        "--rm",
        "-v",
        "/var/run/docker.sock:/var/run/docker.sock",
        "-v",
        `${hostAppsPath}:${hostAppsPath}`,
        "-v",
        `${resolveHostPath(globalSettings.sshKeyPath)}:/root/.ssh:ro`,
        "node:24.16.0-alpine",
        "sh"
    ], { stdio: ["pipe", "pipe", "pipe"] });
    let failed = false;

    worker.on("error", (error) => {
        failed = true;
        const safeError = redactProjectSecrets(error, appSettings.envSecrets, globalSettings);
        console.error(`Deployment Aborted: ${safeError.message}`);
        hooks.onFailure?.(safeError);
    });

    worker.on("close", (code, signal) => {
        if (failed) {
            return;
        }
        if (code === 0) {
            hooks.onSuccess?.();
            return;
        }

        const error = new Error(signal ? `Deployment worker stopped by ${signal}.` : `Deployment worker exited with code ${code ?? "unknown"}.`) as Error & { code?: number | string };
        error.code = code ?? signal ?? "unknown";
        hooks.onFailure?.(redactProjectSecrets(error, appSettings.envSecrets, globalSettings));
    });

    worker.stdout?.on("data", (chunk: Buffer | string) => {
        hooks.onOutput?.("stdout", redactDeploymentOutput(String(chunk), appSettings.envSecrets, globalSettings));
    });

    worker.stderr?.on("data", (chunk: Buffer | string) => {
        hooks.onOutput?.("stderr", redactDeploymentOutput(String(chunk), appSettings.envSecrets, globalSettings));
    });

    worker.stdin?.end(workerScript);

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
 * Reads the persisted effective deployment file from the target host after a
 * successful deploy. This is intentionally captured through the agent/worker
 * boundary because project paths belong to the target server.
 */
export async function captureProjectReleaseSnapshot(repoName: string, appSettings: ProjectSettings, globalSettings: GlobalSettings): Promise<CapturedReleaseSnapshot> {
    const hostAppsPath = appSettings.path ?? defaultProjectPath(globalSettings, repoName);
    const composeProjectName = basename(hostAppsPath.replace(/\/+$/, "")) || repoName;
    const deploymentStrategy = appSettings.deploymentStrategy === "swarm" ? "swarm" : "compose";
    const dockerRunCommand = `docker run -i --rm \
            -v /var/run/docker.sock:/var/run/docker.sock \
            -v ${shellQuote(`${hostAppsPath}:${hostAppsPath}`)} \
            node:24.16.0-alpine sh << 'EOF'
                apk add --no-cache docker-cli docker-cli-compose git > /dev/null 2>&1
                PROJECT_ROOT=${shellQuote(hostAppsPath)}
                PROJECT_ROOT="\${PROJECT_ROOT%/}"
                PROJECT_NAME=${shellQuote(composeProjectName)}
                DEPLOYMENT_STRATEGY=${shellQuote(deploymentStrategy)}
                DEPLOY_FILE="$PROJECT_ROOT/.updater/compose/docker-compose.deploy.yml"
                RELEASE_DEPLOY="$PROJECT_ROOT/.updater/release"

                if [ ! -f "$DEPLOY_FILE" ]; then
                    echo "--> CRITICAL: No persisted deployment Compose file exists at $DEPLOY_FILE." >&2
                    exit 1
                fi

                docker compose -p "$PROJECT_NAME" -f "$DEPLOY_FILE" config --format json > /tmp/deploy-release-compose.json
                if [ $? -ne 0 ]; then
                    echo "--> CRITICAL: Could not inspect persisted deployment Compose file." >&2
                    exit 1
                fi

                GIT_SHA=""
                if [ -d "$RELEASE_DEPLOY/.git" ]; then
                    GIT_SHA="$(git -C "$RELEASE_DEPLOY" rev-parse HEAD 2>/dev/null || true)"
                elif [ -d "$PROJECT_ROOT/.git" ]; then
                    GIT_SHA="$(git -C "$PROJECT_ROOT" rev-parse HEAD 2>/dev/null || true)"
                fi

                echo "${snapshotBeginMarker}"
                node - "$DEPLOY_FILE" /tmp/deploy-release-compose.json "$PROJECT_NAME" "$PROJECT_ROOT" "$DEPLOYMENT_STRATEGY" "$GIT_SHA" << 'DEPLOY_RELEASE_SNAPSHOT_JS'
const fs = require("node:fs");
const deployFile = process.argv[2];
const composeJsonFile = process.argv[3];
const composeProjectName = process.argv[4];
const projectPath = process.argv[5];
const deploymentStrategy = process.argv[6] === "swarm" ? "swarm" : "compose";
const gitSha = process.argv[7] || "";
const composeYaml = fs.readFileSync(deployFile, "utf8");
const compose = JSON.parse(fs.readFileSync(composeJsonFile, "utf8") || "{}");
const services = compose && typeof compose === "object" && compose.services && typeof compose.services === "object" ? compose.services : {};
const images = [];
const buildServices = [];
for (const [serviceName, service] of Object.entries(services)) {
  if (!service || typeof service !== "object") {
    continue;
  }
  if (service.image) {
    images.push({ service: serviceName, image: String(service.image) });
  }
  if (service.build != null) {
    buildServices.push(serviceName);
  }
}
process.stdout.write(JSON.stringify({
  serverId: "",
  composeProjectName,
  projectPath,
  deploymentStrategy,
  composeYaml,
  gitSha,
  images,
  buildServices
}, null, 2) + "\\n");
DEPLOY_RELEASE_SNAPSHOT_JS
                echo "${snapshotEndMarker}"
EOF`;

    const { stdout } = await execAsync(dockerRunCommand, { maxBuffer: 16 * 1024 * 1024 });
    const parsed = parseMarkedJson(stdout, snapshotBeginMarker, snapshotEndMarker) as CapturedReleaseSnapshot;
    if (!parsed.composeYaml?.trim()) {
        throw new Error("Release snapshot did not contain Compose YAML.");
    }

    return {
        ...parsed,
        serverId: appSettings.serverId ?? "local",
        gitSha: parsed.gitSha?.trim() || undefined,
        images: Array.isArray(parsed.images) ? parsed.images : [],
        buildServices: Array.isArray(parsed.buildServices) ? parsed.buildServices : []
    };
}

/**
 * Redeploys one previously captured image-based release snapshot.
 */
export function dispatchReleaseRollbackWorker(release: ProjectReleaseSnapshot, globalSettings: GlobalSettings, hooks: DeploymentHooks = {}): RuntimeLogStream {
    const hostAppsPath = release.projectPath;
    const composeProjectName = release.composeProjectName;
    const deploymentStrategy = release.deploymentStrategy === "swarm" ? "swarm" : "compose";
    const registryAddress = globalSettings.registryAddress.trim();
    const registryUsername = globalSettings.registryUsername.trim();
    const registryPassword = globalSettings.registryPassword?.trim() ?? "";
    const composeDelimiter = uniqueHereDocDelimiter("DEPLOY_ROLLBACK_COMPOSE_EOF", release.composeYaml);

    const workerScript = `
                apk add --no-cache docker-cli docker-cli-compose > /dev/null 2>&1

                PROJECT_ROOT=${shellQuote(hostAppsPath)}
                PROJECT_ROOT="\${PROJECT_ROOT%/}"
                PROJECT_NAME=${shellQuote(composeProjectName)}
                DEPLOYMENT_STRATEGY=${shellQuote(deploymentStrategy)}
                REGISTRY_ADDRESS=${shellQuote(registryAddress)}
                REGISTRY_USERNAME=${shellQuote(registryUsername)}
                REGISTRY_PASSWORD=${shellQuote(registryPassword)}
                ROLLBACK_WORKSPACE="$PROJECT_ROOT/.updater/rollback"
                COMPOSE_WORKSPACE="$PROJECT_ROOT/.updater/compose"
                ROLLBACK_FILE="$ROLLBACK_WORKSPACE/${release.id}.yml"
                PERSISTED_FILE="$COMPOSE_WORKSPACE/docker-compose.deploy.yml"
                mkdir -p "$ROLLBACK_WORKSPACE" "$COMPOSE_WORKSPACE"

                cat > "$ROLLBACK_FILE" << '${composeDelimiter}'
${release.composeYaml}
${composeDelimiter}

                if [ -n "$REGISTRY_USERNAME" ]; then
                    if [ -z "$REGISTRY_PASSWORD" ]; then
                        echo "--> CRITICAL: Registry username is configured, but the registry password is empty."
                        exit 1
                    fi
                    if [ -n "$REGISTRY_ADDRESS" ]; then
                        echo "--> Logging in to Docker registry $REGISTRY_ADDRESS..."
                        printf '%s' "$REGISTRY_PASSWORD" | docker login "$REGISTRY_ADDRESS" --username "$REGISTRY_USERNAME" --password-stdin >/dev/null
                    fi
                fi

                echo "--> Redeploying release snapshot ${release.id}..."
                if [ "$DEPLOYMENT_STRATEGY" = "swarm" ]; then
                    if [ "$(docker info --format '{{.Swarm.ControlAvailable}}' 2>/dev/null || echo false)" != "true" ]; then
                        echo "--> CRITICAL: Swarm rollback must run on a Docker Swarm manager agent."
                        exit 1
                    fi
                    if [ -n "$REGISTRY_USERNAME" ]; then
                        docker stack deploy --with-registry-auth -c "$ROLLBACK_FILE" "$PROJECT_NAME"
                    else
                        docker stack deploy -c "$ROLLBACK_FILE" "$PROJECT_NAME"
                    fi
                    if [ $? -ne 0 ]; then
                        echo "--> CRITICAL: Swarm rollback deploy failed."
                        exit 1
                    fi
                else
                    echo "--> Pulling release images when available..."
                    docker compose -p "$PROJECT_NAME" -f "$ROLLBACK_FILE" pull || echo "--> Image pull failed or was partially unavailable; continuing with local image cache."
                    echo "--> Recreating services from release snapshot..."
                    docker compose -p "$PROJECT_NAME" -f "$ROLLBACK_FILE" up -d --no-build --remove-orphans
                    if [ $? -ne 0 ]; then
                        echo "--> CRITICAL: Compose rollback failed."
                        exit 1
                    fi
                fi

                cp "$ROLLBACK_FILE" "$PERSISTED_FILE"
                echo "--> Rollback deployment successful."`;

    const worker = spawn("docker", [
        "run",
        "-i",
        "--rm",
        "-v",
        "/var/run/docker.sock:/var/run/docker.sock",
        "-v",
        `${hostAppsPath}:${hostAppsPath}`,
        "node:24.16.0-alpine",
        "sh"
    ], { stdio: ["pipe", "pipe", "pipe"] });
    let failed = false;

    worker.on("error", (error) => {
        failed = true;
        hooks.onFailure?.(error);
    });

    worker.on("close", (code, signal) => {
        if (failed) {
            return;
        }
        if (code === 0) {
            hooks.onSuccess?.();
            return;
        }

        const error = new Error(signal ? `Rollback worker stopped by ${signal}.` : `Rollback worker exited with code ${code ?? "unknown"}.`) as Error & { code?: number | string };
        error.code = code ?? signal ?? "unknown";
        hooks.onFailure?.(error);
    });

    worker.stdout?.on("data", (chunk: Buffer | string) => hooks.onOutput?.("stdout", redactDeploymentOutput(String(chunk), [], globalSettings)));
    worker.stderr?.on("data", (chunk: Buffer | string) => hooks.onOutput?.("stderr", redactDeploymentOutput(String(chunk), [], globalSettings)));
    worker.stdin?.end(workerScript);

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
 * Tests Docker registry credentials from the target server's Docker runtime.
 */
export async function testRegistryLogin(globalSettings: GlobalSettings): Promise<RegistryLoginCheck> {
    const checkedAt = new Date().toISOString();
    const registryAddress = globalSettings.registryAddress.trim();
    const registryUsername = globalSettings.registryUsername.trim();
    const registryPassword = globalSettings.registryPassword?.trim() ?? "";

    if (!registryAddress) {
        return {
            checkedAt,
            ok: false,
            skipped: true,
            detail: "No registry address is configured."
        };
    }

    if (!registryUsername) {
        return {
            checkedAt,
            ok: true,
            skipped: true,
            detail: "No registry username is configured; anonymous registry access was not verified."
        };
    }

    if (!registryPassword) {
        return {
            checkedAt,
            ok: false,
            skipped: false,
            detail: "Registry username is configured, but the password is empty."
        };
    }

    const dockerRunCommand = `docker run -i --rm \
            -v /var/run/docker.sock:/var/run/docker.sock \
            alpine:latest sh << 'EOF'
                apk add --no-cache docker-cli > /dev/null 2>&1
                REGISTRY_ADDRESS=${shellQuote(registryAddress)}
                REGISTRY_USERNAME=${shellQuote(registryUsername)}
                REGISTRY_PASSWORD=${shellQuote(registryPassword)}
                if printf '%s' "$REGISTRY_PASSWORD" | docker login "$REGISTRY_ADDRESS" --username "$REGISTRY_USERNAME" --password-stdin >/tmp/deploy-registry-login.txt 2>&1; then
                    exit 0
                fi
                cat /tmp/deploy-registry-login.txt >&2
                exit 1
EOF`;

    try {
        await execAsync(dockerRunCommand, { maxBuffer: 1024 * 1024 });
        return {
            checkedAt,
            ok: true,
            skipped: false,
            detail: `Registry login succeeded for ${registryAddress}.`
        };
    } catch (error) {
        const failure = error as { stdout?: string; stderr?: string; message?: string };
        const detail = redactDeploymentOutput(`${failure.stdout || ""}${failure.stderr ? `\n${failure.stderr}` : ""}`.trim() || failure.message || "Registry login failed.", [], globalSettings);
        return {
            checkedAt,
            ok: false,
            skipped: false,
            detail
        };
    }
}

function renderSecretComposeOverlayScript(secrets: ProjectEnvironmentSecret[] | undefined) {
    const validSecrets = (secrets ?? [])
        .map((secret) => ({
            service: secret.service.trim(),
            key: secret.key.trim(),
            value: secret.value,
            mode: secret.mode === "env" ? "env" as const : "docker_secret" as const
        }))
        .filter((secret) => secret.service && secret.key && secret.value);

    if (!validSecrets.length) {
        return "";
    }

    const secretDir = "$COMPOSE_WORKSPACE/secrets";
    const lines = [
        "",
        "                echo \"--> Preparing sensitive environment values.\"",
        `                mkdir -p "${secretDir}"`,
        "                chmod 700 \"$COMPOSE_WORKSPACE/secrets\"",
        "                cat > \"$COMPOSE_WORKSPACE/docker-compose.secrets.yml\" << 'DEPLOY_SECRETS_EOF'",
        "services:"
    ];
    const services = [...new Set(validSecrets.map((secret) => secret.service))];
    const dockerSecrets = validSecrets.filter((secret) => secret.mode === "docker_secret");

    for (const service of services) {
        const serviceSecrets = validSecrets.filter((secret) => secret.service === service);
        lines.push(`  ${yamlKey(service)}:`);
        lines.push("    environment:");
        for (const secret of serviceSecrets) {
            const secretName = composeSecretName(service, secret.key);
            if (secret.mode === "env") {
                lines.push(`      ${yamlKey(secret.key)}: ${yamlScalar(secret.value)}`);
            } else {
                lines.push(`      ${yamlKey(`${secret.key}_FILE`)}: ${yamlScalar(`/run/secrets/${secretName}`)}`);
            }
        }
        if (serviceSecrets.some((secret) => secret.mode === "docker_secret")) {
            lines.push("    secrets:");
            for (const secret of serviceSecrets.filter((entry) => entry.mode === "docker_secret")) {
                lines.push(`      - ${yamlKey(composeSecretName(service, secret.key))}`);
            }
        }
    }

    if (dockerSecrets.length) {
        lines.push("secrets:");
        for (const secret of dockerSecrets) {
            const secretName = composeSecretName(secret.service, secret.key);
            lines.push(`  ${yamlKey(secretName)}:`);
            lines.push(`    file: ${yamlScalar(`${secretDir}/${secretName}`)}`);
        }
    }

    lines.push("DEPLOY_SECRETS_EOF");

    for (const secret of dockerSecrets) {
        const secretName = composeSecretName(secret.service, secret.key);
        lines.push(`                cat > "$COMPOSE_WORKSPACE/secrets/${secretName}" << 'DEPLOY_SECRET_VALUE_EOF'`);
        lines.push(secret.value);
        lines.push("DEPLOY_SECRET_VALUE_EOF");
        lines.push(`                chmod 600 "$COMPOSE_WORKSPACE/secrets/${secretName}"`);
    }

    lines.push("                COMPOSE_FILES=\"$COMPOSE_FILES -f $COMPOSE_WORKSPACE/docker-compose.secrets.yml\"");
    return lines.join("\n");
}

function renderRegistryComposeRewriteScript() {
    return `
                    docker compose -p "$PROJECT_NAME" $COMPOSE_FILES config --format json > /tmp/deploy-compose-registry.json
                    node - "$COMPOSE_WORKSPACE/docker-compose.deploy.yml" /tmp/deploy-compose-registry.json "$REGISTRY_ADDRESS" "$REGISTRY_IMAGE_NAMESPACE" "$REGISTRY_IMAGE_TAG" "$PROJECT_NAME" << 'DEPLOY_REGISTRY_REWRITE_JS'
const fs = require("node:fs");

const outputPath = process.argv[2];
const inputPath = process.argv[3];
const registryAddress = process.argv[4].replace(/\\/+$/, "");
const namespace = sanitizePathPart(process.argv[5] || "app");
const tag = sanitizeTag(process.argv[6] || "latest");
const projectName = sanitizeName(process.argv[7] || "project");
const data = JSON.parse(fs.readFileSync(inputPath, "utf8") || "{}");
const services = data && typeof data === "object" && data.services && typeof data.services === "object" ? data.services : {};
let changed = 0;
const registryServices = [];

for (const [serviceName, service] of Object.entries(services)) {
  if (!service || typeof service !== "object" || service.build == null) {
    continue;
  }

  service.image = registryAddress + "/" + namespace + "/" + projectName + "-" + sanitizeName(serviceName) + ":" + tag;
  registryServices.push(serviceName);
  changed += 1;
}

if (!changed) {
  console.log("--> No build-backed services found for registry image tagging.");
}

fs.writeFileSync(outputPath, JSON.stringify(data, null, 2) + "\\n");
fs.writeFileSync("/tmp/deploy-registry-services", registryServices.map(shellArg).join(" "));

function sanitizePathPart(value) {
  return String(value)
    .split("/")
    .map((part) => sanitizeName(part))
    .filter(Boolean)
    .join("/") || "app";
}

function sanitizeName(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "service";
}

function sanitizeTag(value) {
  return String(value).replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "latest";
}

function shellArg(value) {
  return /^[a-zA-Z0-9_./:@=-]+$/.test(value) ? value : "'" + String(value).replace(/'/g, "'\\\\''") + "'";
}
DEPLOY_REGISTRY_REWRITE_JS`;
}

function renderRegistryStripBuildScript() {
    return `
                    docker compose -p "$PROJECT_NAME" $COMPOSE_FILES config --format json > /tmp/deploy-compose-registry-pull.json
                    node - "$COMPOSE_WORKSPACE/docker-compose.deploy.yml" /tmp/deploy-compose-registry-pull.json << 'DEPLOY_REGISTRY_PULL_JS'
const fs = require("node:fs");

const outputPath = process.argv[2];
const inputPath = process.argv[3];
const data = JSON.parse(fs.readFileSync(inputPath, "utf8") || "{}");
const services = data && typeof data === "object" && data.services && typeof data.services === "object" ? data.services : {};

for (const service of Object.values(services)) {
  if (service && typeof service === "object" && service.image) {
    delete service.build;
  }
}

fs.writeFileSync(outputPath, JSON.stringify(data, null, 2) + "\\n");
DEPLOY_REGISTRY_PULL_JS`;
}

function composeSecretName(service: string, key: string) {
    return `${service}_${key}`.toLowerCase().replace(/[^a-z0-9_.-]+/g, "_").replace(/^_+|_+$/g, "") || "deploy_secret";
}

function yamlKey(value: string) {
    return /^[a-zA-Z0-9._-]+$/.test(value.trim()) ? value.trim() : yamlScalar(value.trim());
}

function yamlScalar(value: string) {
    const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    return `"${escaped}"`;
}

function parseMarkedJson(output: string, beginMarker: string, endMarker: string) {
    const begin = output.indexOf(beginMarker);
    const end = begin >= 0 ? output.indexOf(endMarker, begin + beginMarker.length) : -1;
    if (begin < 0 || end < 0 || end <= begin) {
        throw new Error("Release snapshot output did not contain marked JSON.");
    }
    return JSON.parse(output.slice(begin + beginMarker.length, end).trim());
}

function uniqueHereDocDelimiter(base: string, value: string) {
    let delimiter = base;
    let index = 1;
    while (value.includes(delimiter)) {
        delimiter = `${base}_${index++}`;
    }
    return delimiter;
}

function redactProjectSecrets(error: Error & { code?: number | string }, secrets: ProjectEnvironmentSecret[] | undefined, globalSettings?: GlobalSettings) {
    const values = deploymentSecretValues(secrets, globalSettings);
    if (!values.length) {
        return error;
    }

    const safeError = new Error(redactValues(error.message, values)) as Error & { code?: number | string };
    safeError.name = error.name;
    safeError.stack = error.stack ? redactValues(error.stack, values) : error.stack;
    safeError.code = error.code;
    return safeError;
}

function redactDeploymentOutput(value: string, secrets: ProjectEnvironmentSecret[] | undefined, globalSettings: GlobalSettings) {
    return redactValues(value, deploymentSecretValues(secrets, globalSettings));
}

function deploymentSecretValues(secrets: ProjectEnvironmentSecret[] | undefined, globalSettings?: GlobalSettings) {
    return [
        ...(secrets ?? []).map((secret) => secret.value),
        globalSettings?.registryPassword ?? ""
    ].filter((value) => value.length >= 3);
}

function redactValues(value: string, secrets: string[]) {
    return secrets.reduce((current, secret) => current.split(secret).join("[secret]"), value);
}

/**
 * Runs `docker compose down` for a project using the same compose file selection
 * rules as a deployment.
 */
export async function stopProjectContainers(repoName: string, appSettings: ProjectSettings, globalSettings: GlobalSettings) {
    const hostAppsPath = appSettings.path ?? defaultProjectPath(globalSettings, repoName);
    const composeProjectName = basename(hostAppsPath.replace(/\/+$/, "")) || repoName;
    const deploymentStrategy = appSettings.deploymentStrategy === "swarm" ? "swarm" : "compose";
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
                DEPLOYMENT_STRATEGY=${shellQuote(deploymentStrategy)}
                COMPOSE_WORKSPACE="$PROJECT_ROOT/.updater/compose"

                if [ "$DEPLOYMENT_STRATEGY" = "swarm" ]; then
                    echo "--> Removing Swarm stack..."
                    docker stack rm "$PROJECT_NAME"
                    exit $?
                fi

                if [ -f "$COMPOSE_WORKSPACE/docker-compose.deploy.yml" ]; then
                    echo "--> Using persisted Deploy Compose file."
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
                TARGET_PATH=${shellQuote(`${parentPath}/${checkoutName}`)}
                CHECKOUT_NAME=${shellQuote(checkoutName)}
                ACTIVE_MARKER=${shellQuote(`${parentPath}/deploy.active`)}
                if { [ "$CHECKOUT_NAME" = "tmpdeploy" ] || [ "$CHECKOUT_NAME" = "release" ]; } && [ -f "$ACTIVE_MARKER" ]; then
                    NOW="$(date +%s)"
                    START="$(cat "$ACTIVE_MARKER" 2>/dev/null || echo 0)"
                    case "$START" in
                        ''|*[!0-9]*) START=0 ;;
                    esac
                    AGE=$((NOW - START))
                    if [ "$AGE" -lt 3600 ]; then
                        echo "--> Docker host cleanup skipped: active deployment marker is \${AGE}s old."
                        exit 0
                    fi
                    echo "--> Docker host cleanup found stale deployment marker (\${AGE}s old); continuing."
                    rm -f "$ACTIVE_MARKER"
                fi
                echo "--> Docker host cleanup exists before delete: $(test -e "$TARGET_PATH" && echo true || echo false)"
                rm -rf -- "$TARGET_PATH"
                if [ -e "$TARGET_PATH" ]; then
                    echo "--> CRITICAL: Docker host checkout path still exists after rm."
                    exit 1
                fi
                echo "--> Docker host cleanup verified path removed."
EOF`;

    const { stdout, stderr } = await execAsync(dockerRunCommand, { maxBuffer: 8 * 1024 * 1024 });
    return `${stdout}${stderr ? `\n${stderr}` : ""}`.trim();
}

/**
 * Reports running-container bind mounts that still reference a checkout path.
 */
export async function inspectCheckoutBindMounts(checkoutPath: string): Promise<CheckoutBindMountInspection> {
    const normalizedCheckoutPath = checkoutPath.replace(/\/+$/, "");
    const dockerRunCommand = `docker run -i --rm \
            -v /var/run/docker.sock:/var/run/docker.sock \
            alpine:latest sh << 'EOF'
                apk add --no-cache docker-cli > /dev/null 2>&1
                IDS="$(docker ps -q)"
                if [ -z "$IDS" ]; then
                    echo "[]"
                    exit 0
                fi
                docker inspect $IDS
EOF`;

    const { stdout } = await execAsync(dockerRunCommand, { maxBuffer: 8 * 1024 * 1024 });
    const containers = JSON.parse(stdout.trim() || "[]") as DockerInspectContainerWithMounts[];
    const references = containers.flatMap((container) =>
        (container.Mounts ?? [])
            .filter((mount) => mount.Type === "bind" && isPathInside(normalizedCheckoutPath, mount.Source))
            .map((mount) => ({
                containerName: container.Name?.replace(/^\//, ""),
                containerId: container.Id,
                source: mount.Source,
                target: mount.Destination
            }))
    );

    return {
        checkoutPath: normalizedCheckoutPath,
        checkedAt: new Date().toISOString(),
        references
    };
}

function isPathInside(parentPath: string, candidatePath: string) {
    const normalizedParent = parentPath.replace(/\/+$/, "");
    const normalizedCandidate = candidatePath.replace(/\/+$/, "");
    return normalizedCandidate === normalizedParent || normalizedCandidate.startsWith(`${normalizedParent}/`);
}

/**
 * Checks whether the target Docker server appears to have Traefik available.
 */
export async function detectTraefik(globalSettings: GlobalSettings): Promise<ServerCapabilities["traefik"]> {
    const networkName = globalSettings.defaultTraefikNetwork || "proxy";
    const checkedAt = new Date().toISOString();
    const result = await inspectTraefikContainers(networkName);
    if (!result.ok) {
        return {
            available: false,
            containerCount: 0,
            networkPresent: false,
            checkedAt
        };
    }

    const inventory = await buildTraefikInventory(result.inspect, result.services, result.containerCount + result.serviceCount, result.networkPresent, networkName, checkedAt);
    return inventory;
}

export async function backupTraefikConfig(serverId: string, globalSettings: GlobalSettings): Promise<TraefikConfigBackup> {
    const networkName = globalSettings.defaultTraefikNetwork || "proxy";
    const checkedAt = new Date().toISOString();
    const result = await inspectTraefikContainers(networkName);
    const inspect = result.ok ? result.inspect : [];
    const inventory = result.ok
        ? await buildTraefikInventory(inspect, result.services, result.containerCount + result.serviceCount, result.networkPresent, networkName, checkedAt)
        : {
              available: false,
              containerCount: 0,
              networkPresent: false,
              checkedAt
          };

    return {
        serverId,
        createdAt: new Date().toISOString(),
        inventory,
        files: await collectTraefikBackupFiles(inspect)
    };
}

export async function validateTraefikConfig(serverId: string, globalSettings: GlobalSettings): Promise<TraefikConfigValidation> {
    const networkName = globalSettings.defaultTraefikNetwork || "proxy";
    const checkedAt = new Date().toISOString();
    const result = await inspectTraefikContainers(networkName);
    const inspect = result.ok ? result.inspect : [];
    const inventory = result.ok
        ? await buildTraefikInventory(inspect, result.services, result.containerCount + result.serviceCount, result.networkPresent, networkName, checkedAt)
        : {
              available: false,
              containerCount: 0,
              networkPresent: false,
              checkedAt
          };
    const checks: TraefikConfigValidationCheck[] = [];

    if (!result.ok) {
        checks.push({
            key: "docker-inspect",
            label: "Docker inspection",
            status: "fail",
            detail: "Could not inspect Traefik containers on this server."
        });
    }

    checks.push({
        key: "traefik-workload",
        label: "Traefik workload",
        status: inventory.containerCount > 0 ? "pass" : "fail",
        detail: inventory.containerCount > 0 ? `${inventory.containerCount} Traefik container/service workload(s) found.` : "No Traefik container or Swarm service was found."
    });

    checks.push({
        key: "entrypoints",
        label: "Entrypoints",
        status: inventory.entryPoints?.length ? "pass" : "warn",
        detail: inventory.entryPoints?.length ? `Detected ${inventory.entryPoints.join(", ")}.` : "No entrypoints were detected from mounted static config or command args."
    });

    checks.push({
        key: "cert-resolvers",
        label: "Certificate resolvers",
        status: inventory.certResolvers?.length ? "pass" : "warn",
        detail: inventory.certResolvers?.length ? `Detected ${inventory.certResolvers.join(", ")}.` : "No certificate resolvers were detected."
    });

    checks.push({
        key: "docker-provider-network",
        label: "Docker provider network",
        status: inventory.dockerProviderNetwork ? "pass" : "warn",
        detail: inventory.dockerProviderNetwork ? `Using ${inventory.dockerProviderNetwork}.` : "No Docker provider network was configured or safely inferred."
    });

    const providerNetworkDetail = inventory.networkDetails?.find((network) => network.name === inventory.dockerProviderNetwork);
    if (providerNetworkDetail?.driver === "overlay" && providerNetworkDetail.attachable === false) {
        checks.push({
            key: "docker-provider-network-attachable",
            label: "Compose attachable network",
            status: "warn",
            detail: `${providerNetworkDetail.name} is a Swarm overlay network but is not attachable. Normal Docker Compose containers cannot reliably join it; recreate/update it as attachable or deploy the app as a Swarm service.`
        });
    }

    if (inventory.certResolvers?.length) {
        checks.push({
            key: "acme-storage",
            label: "ACME storage",
            status: inventory.acmeStorage ? "pass" : "warn",
            detail: inventory.acmeStorage ? `Using ${inventory.acmeStorage}.` : "Certificate resolvers exist, but ACME storage was not detected."
        });
    }

    const staticConfigChecks = await validateMountedTraefikStaticConfigs(inspect);
    checks.push(...staticConfigChecks);

    if (inventory.containerCount > 0 && !staticConfigChecks.length) {
        checks.push({
            key: "static-config",
            label: "Static config check",
            status: "warn",
            detail: "No mounted Traefik static config file was found. Command-line configuration was inspected only."
        });
    }

    return {
        serverId,
        checkedAt,
        status: summarizeValidationStatus(checks),
        inventory,
        checks
    };
}

export async function applyTraefikDefaults(serverId: string, globalSettings: GlobalSettings, defaults: TraefikDefaultsPayload): Promise<TraefikConfigApplyResult> {
    const actions: string[] = [];
    const backup = await backupTraefikConfig(serverId, globalSettings);
    const target = backup.files.find((file) => file.kind === "static" && !file.error && isSupportedTraefikConfigPath(file.path));
    if (!target) {
        throw new Error("No writable mounted Traefik static config file was discovered. Export backup and manage this server manually.");
    }

    const nextContent = renderManagedTraefikStaticConfig(target.content, defaults);
    if (nextContent === target.content) {
        return {
            serverId,
            appliedAt: new Date().toISOString(),
            changed: false,
            target: traefikApplyTarget(target),
            backup: target,
            validation: await validateTraefikConfig(serverId, globalSettings),
            actions: ["Static Traefik config already matches requested defaults."]
        };
    }

    actions.push(`Created in-memory backup for ${target.path}.`);
    await writeMountedTraefikConfig(target, nextContent);
    actions.push(`Updated ${target.path} through target-server Docker mount.`);
    const validation = await validateTraefikConfig(serverId, {
        ...globalSettings,
        defaultTraefikNetwork: defaults.network?.trim() || globalSettings.defaultTraefikNetwork,
        defaultTraefikEntryPoints: defaults.entryPoints?.trim() || globalSettings.defaultTraefikEntryPoints,
        defaultTraefikCertResolver: defaults.certResolver?.trim() || globalSettings.defaultTraefikCertResolver
    });

    if (validation.status === "fail") {
        await writeMountedTraefikConfig(target, target.content);
        actions.push("Validation failed after write; restored previous static config content.");
        throw new Error(`Traefik config validation failed after apply. Previous content was restored. ${validation.checks.find((check) => check.status === "fail")?.detail ?? ""}`.trim());
    }

    actions.push(`Validation ${validation.status} after apply.`);
    return {
        serverId,
        appliedAt: new Date().toISOString(),
        changed: true,
        target: traefikApplyTarget(target),
        backup: target,
        validation,
        actions
    };
}

async function inspectTraefikContainers(networkName: string) {
    const command = `TRAEFIK_IDS="$(docker ps -aq --filter label=org.opencontainers.image.title=Traefik)"
if [ -z "$TRAEFIK_IDS" ]; then
    TRAEFIK_IDS="$(docker ps -aq --filter label=com.docker.swarm.service.name=traefik)"
fi
if [ -z "$TRAEFIK_IDS" ]; then
    TRAEFIK_IDS="$(docker ps -aq --filter label=com.docker.stack.namespace=traefik)"
fi
if [ -z "$TRAEFIK_IDS" ]; then
    TRAEFIK_IDS="$(docker ps -a --format '{{.ID}} {{.Image}} {{.Names}} {{.Label "com.docker.swarm.service.name"}} {{.Label "com.docker.stack.namespace"}}' | grep -Ei '(^|[ /_])traefik(:| |$|_)' | awk '{print $1}')"
fi
if [ -z "$TRAEFIK_IDS" ]; then
    TRAEFIK_IDS="$(docker ps -a --format '{{.ID}} {{.Image}} {{.Names}}' | grep -Ei '(^|[ /])traefik(:| |$)' | awk '{print $1}')"
fi
TRAEFIK_SERVICE_IDS="$(docker service ls --format '{{.ID}} {{.Image}} {{.Name}}' 2>/dev/null | grep -Ei '(^|[ /])traefik(:| |$)' | awk '{print $1}')"
CONTAINERS="$(printf '%s\\n' "$TRAEFIK_IDS" | sed '/^$/d' | wc -l | tr -d ' ')"
SERVICES="$(printf '%s\\n' "$TRAEFIK_SERVICE_IDS" | sed '/^$/d' | wc -l | tr -d ' ')"
NETWORK_PRESENT="$(docker network inspect ${shellQuote(networkName)} > /dev/null 2>&1 && echo true || echo false)"
printf '{"containerCount":%s,"serviceCount":%s,"networkPresent":%s,"inspect":' "$CONTAINERS" "$SERVICES" "$NETWORK_PRESENT"
if [ -n "$TRAEFIK_IDS" ]; then
    docker inspect $TRAEFIK_IDS
else
    printf '[]'
fi
printf ',"services":'
if [ -n "$TRAEFIK_SERVICE_IDS" ]; then
    docker service inspect $TRAEFIK_SERVICE_IDS
else
    printf '[]'
fi
printf '}\\n'`;

    try {
        const { stdout } = await execAsync(command, { maxBuffer: 1024 * 1024 });
        const result = JSON.parse(stdout.trim() || "{}") as { containerCount?: number; serviceCount?: number; networkPresent?: boolean; inspect?: DockerInspectContainerWithMounts[]; services?: DockerInspectService[] };
        return {
            ok: true as const,
            containerCount: Number(result.containerCount || 0),
            serviceCount: Number(result.serviceCount || 0),
            networkPresent: Boolean(result.networkPresent),
            inspect: result.inspect ?? [],
            services: result.services ?? []
        };
    } catch (error) {
        return { ok: false as const, containerCount: 0, serviceCount: 0, networkPresent: false, inspect: [] as DockerInspectContainerWithMounts[], services: [] as DockerInspectService[] };
    }
}

async function buildTraefikInventory(inspectedContainers: DockerInspectContainerWithMounts[], inspectedServices: DockerInspectService[], containerCount: number, networkPresent: boolean, networkName: string, checkedAt: string): Promise<ServerCapabilities["traefik"]> {
    const rawContainers = [
        ...inspectedContainers.map(parseTraefikContainerInventory),
        ...inspectedServices.map(parseTraefikServiceInventory)
    ];
    const networkNameMap = await resolveDockerNetworkNames(unique(rawContainers.flatMap((container) => container.networks)));
    const containers = rawContainers.map((container) => ({
        ...container,
        networks: unique(container.networks.map((network) => networkNameMap[network] || network))
    }));
    const networkDetails = await inspectDockerNetworks(unique(containers.flatMap((container) => container.networks)));
    const configArgs = containers.flatMap((container) => container.configArgs);
    const mountedTargets = containers.flatMap((container) => container.mounts.map((mount) => mount.target));
    const staticConfig = await readTraefikStaticConfigInventory(inspectedContainers);
    const entryPoints = unique([...extractTraefikKeys(configArgs, /^--entrypoints\.([^.=\s]+)\./), ...staticConfig.entryPoints]);
    const certResolvers = unique([...extractTraefikKeys(configArgs, /^--certificatesresolvers\.([^.=\s]+)\./), ...staticConfig.certResolvers]);
    const dockerProviderNetwork = extractTraefikValue(configArgs, "--providers.docker.network=") || staticConfig.dockerProviderNetwork || inferTraefikDockerNetwork(containers, networkName);
    const swarmProviderNetwork = extractTraefikValue(configArgs, "--providers.swarm.network=") || staticConfig.swarmProviderNetwork;
    const providerMode = detectTraefikProviderMode(configArgs, staticConfig);
    const acmeStorage = extractTraefikValue(configArgs, "--certificatesresolvers.", ".acme.storage=") || staticConfig.acmeStorage;

    return {
        available: containerCount > 0 || networkPresent,
        containerCount,
        networkPresent,
        checkedAt,
        providerMode,
        ...(containers.length ? { containers } : {}),
        ...(unique(containers.flatMap((container) => container.networks)).length ? { networks: unique(containers.flatMap((container) => container.networks)) } : {}),
        ...(networkDetails.length ? { networkDetails } : {}),
        ...(entryPoints.length ? { entryPoints } : {}),
        ...(certResolvers.length ? { certResolvers } : {}),
        ...(swarmProviderNetwork || dockerProviderNetwork ? { dockerProviderNetwork: swarmProviderNetwork || dockerProviderNetwork } : {}),
        ...(acmeStorage ? { acmeStorage } : {}),
        ...(mountedTargets.filter(isLikelyTraefikStaticConfigPath).length ? { staticConfigPaths: unique(mountedTargets.filter(isLikelyTraefikStaticConfigPath)) } : {}),
        ...(mountedTargets.filter(isLikelyTraefikDynamicConfigPath).length ? { dynamicConfigPaths: unique(mountedTargets.filter(isLikelyTraefikDynamicConfigPath)) } : {})
    };
}

async function resolveDockerNetworkNames(networks: string[]) {
    const candidates = unique(networks.filter(Boolean));
    if (!candidates.length) {
        return {} as Record<string, string>;
    }

    const command = candidates.map((network) => `docker network inspect ${shellQuote(network)} --format '{{.Id}} {{.Name}}' 2>/dev/null || true`).join("\n");
    try {
        const { stdout } = await execAsync(command, { maxBuffer: 128 * 1024 });
        return stdout
            .trim()
            .split(/\r?\n/)
            .filter(Boolean)
            .reduce<Record<string, string>>((result, line) => {
                const [id, name] = line.trim().split(/\s+/, 2);
                if (id && name) {
                    result[id] = name;
                    result[id.slice(0, 12)] = name;
                    result[name] = name;
                }
                return result;
            }, {});
    } catch {
        return {};
    }
}

async function inspectDockerNetworks(networks: string[]): Promise<DockerNetworkInventory[]> {
    const candidates = unique(networks.filter(Boolean));
    if (!candidates.length) {
        return [];
    }

    try {
        const { stdout } = await execAsync(`docker network inspect ${candidates.map(shellQuote).join(" ")}`, { maxBuffer: 256 * 1024 });
        const inspected = JSON.parse(stdout.trim() || "[]") as DockerInspectNetwork[];
        return inspected.map((network) => ({
            ...(network.Id ? { id: network.Id.slice(0, 12) } : {}),
            name: network.Name,
            ...(network.Driver ? { driver: network.Driver } : {}),
            ...(network.Scope ? { scope: network.Scope } : {}),
            ...(typeof network.Attachable === "boolean" ? { attachable: network.Attachable } : {}),
            ...(typeof network.Ingress === "boolean" ? { ingress: network.Ingress } : {})
        })).filter((network) => network.name);
    } catch {
        return [];
    }
}

function parseTraefikContainerInventory(container: DockerInspectContainerWithMounts): TraefikContainerInventory {
    const args = [...(container.Args ?? []), ...(container.Config?.Cmd ?? [])].filter((arg) => arg.startsWith("--"));
    const networks = Object.keys(container.NetworkSettings?.Networks ?? {});
    return {
        kind: "container",
        ...(container.Id ? { id: container.Id.slice(0, 12) } : {}),
        ...(container.Name ? { name: container.Name.replace(/^\/+/, "") } : {}),
        ...(container.Config?.Image ? { image: container.Config.Image } : {}),
        ...(container.State?.Status ? { state: container.State.Status } : {}),
        ...(formatPublishedPorts(container.NetworkSettings?.Ports) ? { ports: formatPublishedPorts(container.NetworkSettings?.Ports) } : {}),
        networks,
        mounts: (container.Mounts ?? []).map((mount) => ({ source: mount.Source, target: mount.Destination })),
        configArgs: args
    };
}

function parseTraefikServiceInventory(service: DockerInspectService): TraefikContainerInventory {
    const containerSpec = service.Spec?.TaskTemplate?.ContainerSpec;
    const args = [...(containerSpec?.Args ?? []), ...(containerSpec?.Command ?? [])].filter((arg) => arg.startsWith("--"));
    const networks = unique([
        ...(service.Spec?.TaskTemplate?.Networks ?? []).map((network) => network.Target).filter(Boolean),
        ...(service.Endpoint?.VirtualIPs ?? []).map((network) => network.NetworkID).filter(Boolean)
    ]);
    const ports = formatServicePorts(service.Endpoint?.Ports);
    return {
        kind: "service",
        ...(service.ID ? { id: service.ID.slice(0, 12) } : {}),
        ...(service.Spec?.Name ? { name: service.Spec.Name } : {}),
        ...(containerSpec?.Image ? { image: containerSpec.Image } : {}),
        ...(service.ServiceStatus?.RunningTasks !== undefined || service.ServiceStatus?.DesiredTasks !== undefined
            ? { state: `${service.ServiceStatus?.RunningTasks ?? 0}/${service.ServiceStatus?.DesiredTasks ?? 0} running` }
            : {}),
        ...(service.Spec?.Mode?.Replicated?.Replicas !== undefined
            ? { replicas: String(service.Spec.Mode.Replicated.Replicas) }
            : service.Spec?.Mode?.Global ? { replicas: "global" } : {}),
        ...(ports ? { ports } : {}),
        networks,
        mounts: (containerSpec?.Mounts ?? []).map((mount) => ({ source: mount.Source, target: mount.Target })),
        configArgs: args
    };
}

function inferTraefikDockerNetwork(containers: TraefikContainerInventory[], preferredNetwork: string) {
    const networks = unique(containers.flatMap((container) => container.networks));
    if (preferredNetwork && networks.includes(preferredNetwork)) {
        return preferredNetwork;
    }

    const candidates = networks.filter((network) => !["bridge", "host", "none"].includes(network));
    return candidates.length === 1 ? candidates[0] : "";
}

async function readTraefikStaticConfigInventory(containers: DockerInspectContainerWithMounts[]) {
    const inventory = {
        entryPoints: [] as string[],
        certResolvers: [] as string[],
        dockerProviderNetwork: "",
        swarmProviderNetwork: "",
        dockerProviderEnabled: false,
        swarmProviderEnabled: false,
        acmeStorage: ""
    };

    for (const container of containers) {
        if (!container.Id) {
            continue;
        }

        const staticPaths = unique((container.Mounts ?? []).map((mount) => mount.Destination).filter(isLikelyTraefikStaticConfigPath));
        for (const staticPath of staticPaths) {
            const content = await readContainerFile(container.Id, staticPath);
            const parsed = parseTraefikStaticConfig(content);
            inventory.entryPoints.push(...parsed.entryPoints);
            inventory.certResolvers.push(...parsed.certResolvers);
            inventory.dockerProviderNetwork ||= parsed.dockerProviderNetwork;
            inventory.swarmProviderNetwork ||= parsed.swarmProviderNetwork;
            inventory.dockerProviderEnabled ||= parsed.dockerProviderEnabled;
            inventory.swarmProviderEnabled ||= parsed.swarmProviderEnabled;
            inventory.acmeStorage ||= parsed.acmeStorage;
        }
    }

    return {
        entryPoints: unique(inventory.entryPoints),
        certResolvers: unique(inventory.certResolvers),
        dockerProviderNetwork: inventory.dockerProviderNetwork,
        swarmProviderNetwork: inventory.swarmProviderNetwork,
        dockerProviderEnabled: inventory.dockerProviderEnabled,
        swarmProviderEnabled: inventory.swarmProviderEnabled,
        acmeStorage: inventory.acmeStorage
    };
}

async function collectTraefikBackupFiles(containers: DockerInspectContainerWithMounts[]): Promise<TraefikConfigBackupFile[]> {
    const files: TraefikConfigBackupFile[] = [];
    const seen = new Set<string>();

    for (const container of containers) {
        if (!container.Id) {
            continue;
        }

        const containerId = container.Id;
        const containerName = container.Name?.replace(/^\/+/, "");
        for (const mount of container.Mounts ?? []) {
            const kind = classifyTraefikBackupPath(mount.Destination);
            if (kind === "other") {
                continue;
            }

            const discoveredPaths = await discoverContainerFiles(containerId, mount.Destination);
            const paths = discoveredPaths.length ? discoveredPaths : [mount.Destination];
            for (const path of paths) {
                const key = `${containerId}:${path}`;
                if (seen.has(key)) {
                    continue;
                }
                seen.add(key);
                const read = await readContainerFileForBackup(containerId, path);
                files.push({
                    containerId: containerId.slice(0, 12),
                    ...(containerName ? { containerName } : {}),
                    source: mount.Source,
                    mountTarget: mount.Destination,
                    path,
                    kind,
                    content: read.content,
                    truncated: read.truncated,
                    ...(read.error ? { error: read.error } : {})
                });
            }
        }
    }

    return files;
}

async function validateMountedTraefikStaticConfigs(containers: DockerInspectContainerWithMounts[]) {
    const checks: TraefikConfigValidationCheck[] = [];
    const seen = new Set<string>();

    for (const container of containers) {
        if (!container.Id) {
            continue;
        }

        const containerName = container.Name?.replace(/^\/+/, "") || container.Id.slice(0, 12);
        const staticPaths = unique((container.Mounts ?? []).map((mount) => mount.Destination).filter(isLikelyTraefikStaticConfigPath));
        for (const staticPath of staticPaths) {
            const key = `${container.Id}:${staticPath}`;
            if (seen.has(key)) {
                continue;
            }
            seen.add(key);

            const result = await runTraefikStaticConfigCheck(container, staticPath);
            checks.push({
                key: `static-config:${container.Id.slice(0, 12)}:${staticPath}`,
                label: `Static config ${staticPath}`,
                status: result.ok ? "pass" : "fail",
                detail: result.ok
                    ? `${containerName} accepted ${staticPath}.`
                    : `${containerName} rejected ${staticPath}.`,
                ...(result.output ? { output: result.output } : {})
            });
        }
    }

    return checks;
}

async function runTraefikStaticConfigCheck(container: DockerInspectContainerWithMounts, path: string) {
    const containerId = container.Id ?? "";
    const outputLimit = 12 * 1024;
    const image = container.Config?.Image || "traefik:latest";
    const command = `docker run --rm --volumes-from ${shellQuote(`${containerId}:ro`)} --entrypoint traefik ${shellQuote(image)} --configFile=${shellQuote(path)}`;

    try {
        const { stdout, stderr } = await execAsync(command, { maxBuffer: 256 * 1024, timeout: 7000 });
        return {
            ok: true,
            output: trimValidationOutput(`${stdout}${stderr ? `\n${stderr}` : ""}`, outputLimit)
        };
    } catch (error) {
        if (isExecTimeout(error)) {
            return {
                ok: true,
                output: "Traefik accepted the static config and continued running. Validation stopped the dry run after startup."
            };
        }

        const output = typeof error === "object" && error
            ? `${"stdout" in error ? String(error.stdout ?? "") : ""}${"stderr" in error ? `\n${String(error.stderr ?? "")}` : ""}`
            : "";
        return {
            ok: false,
            output: trimValidationOutput(output || (error instanceof Error ? error.message : "Traefik config check failed."), outputLimit)
        };
    }
}

function isExecTimeout(error: unknown) {
    return typeof error === "object" && error !== null && (
        ("signal" in error && error.signal === "SIGTERM") ||
        ("killed" in error && error.killed === true)
    );
}

function trimValidationOutput(output: string, limit: number) {
    const trimmed = output.trim();
    if (trimmed.length <= limit) {
        return trimmed;
    }

    return `${trimmed.slice(0, limit)}\n... truncated ...`;
}

function classifyTraefikBackupPath(path: string): TraefikConfigBackupFile["kind"] {
    if (isLikelyTraefikStaticConfigPath(path)) {
        return "static";
    }

    if (isLikelyTraefikDynamicConfigPath(path) || /\.(ya?ml|toml)$/.test(path)) {
        return "dynamic";
    }

    return "other";
}

async function discoverContainerFiles(containerId: string, path: string) {
    try {
        const { stdout } = await execAsync(
            `docker run --rm --volumes-from ${shellQuote(`${containerId}:ro`)} alpine:latest sh -c 'if [ -d "$1" ]; then find "$1" -maxdepth 3 -type f \\( -name "*.yml" -o -name "*.yaml" -o -name "*.toml" \\) | sort; elif [ -f "$1" ]; then printf "%s\\n" "$1"; fi' sh ${shellQuote(path)}`,
            { maxBuffer: 128 * 1024 }
        );
        return stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    } catch {
        return [];
    }
}

async function readContainerFileForBackup(containerId: string, path: string) {
    const maxBytes = 256 * 1024;
    try {
        const { stdout } = await execAsync(
            `docker run --rm --volumes-from ${shellQuote(`${containerId}:ro`)} alpine:latest sh -c 'if [ -f "$1" ]; then head -c ${maxBytes + 1} "$1"; else printf "__DEPLOY_BACKUP_ERROR__not a file"; fi' sh ${shellQuote(path)}`,
            { maxBuffer: maxBytes + 4096 }
        );
        if (stdout.startsWith("__DEPLOY_BACKUP_ERROR__")) {
            return { content: "", truncated: false, error: stdout.replace("__DEPLOY_BACKUP_ERROR__", "") };
        }

        return {
            content: stdout.slice(0, maxBytes),
            truncated: Buffer.byteLength(stdout) > maxBytes
        };
    } catch (error) {
        return {
            content: "",
            truncated: false,
            error: error instanceof Error ? error.message : "Could not read file."
        };
    }
}

async function readContainerFile(containerId: string, path: string) {
    try {
        const { stdout } = await execAsync(
            `docker run --rm --volumes-from ${shellQuote(`${containerId}:ro`)} alpine:latest sh -c 'cat "$1" 2>/dev/null || true' sh ${shellQuote(path)}`,
            { maxBuffer: 256 * 1024 }
        );
        return stdout;
    } catch {
        return "";
    }
}

function parseTraefikStaticConfig(content: string) {
    return {
        entryPoints: unique([...parseYamlTopLevelObjectKeys(content, "entryPoints"), ...parseTomlSectionKeys(content, "entryPoints")]),
        certResolvers: unique([...parseYamlTopLevelObjectKeys(content, "certificatesResolvers"), ...parseTomlSectionKeys(content, "certificatesResolvers")]),
        dockerProviderNetwork: parseYamlNestedScalar(content, ["providers", "docker", "network"]) || parseTomlScalar(content, "providers.docker", "network"),
        swarmProviderNetwork: parseYamlNestedScalar(content, ["providers", "swarm", "network"]) || parseTomlScalar(content, "providers.swarm", "network"),
        dockerProviderEnabled: hasYamlPath(content, ["providers", "docker"]) || hasTomlSection(content, "providers.docker"),
        swarmProviderEnabled: hasYamlPath(content, ["providers", "swarm"]) || hasTomlSection(content, "providers.swarm"),
        acmeStorage: parseYamlAcmeStorage(content) || parseTomlAcmeStorage(content)
    };
}

function detectTraefikProviderMode(args: string[], staticConfig: ReturnType<typeof readTraefikStaticConfigInventory> extends Promise<infer T> ? T : never): ServerCapabilities["traefik"]["providerMode"] {
    const dockerEnabled = args.some((arg) => arg.startsWith("--providers.docker")) || staticConfig.dockerProviderEnabled || Boolean(staticConfig.dockerProviderNetwork);
    const swarmEnabled = args.some((arg) => arg.startsWith("--providers.swarm")) || staticConfig.swarmProviderEnabled || Boolean(staticConfig.swarmProviderNetwork);
    if (dockerEnabled && swarmEnabled) {
        return "mixed";
    }
    if (swarmEnabled) {
        return "swarm";
    }
    if (dockerEnabled) {
        return "docker";
    }
    return "unknown";
}

function isSupportedTraefikConfigPath(path: string) {
    return /\.(ya?ml|toml)$/i.test(path);
}

function traefikApplyTarget(file: TraefikConfigBackupFile) {
    return {
        ...(file.containerId ? { containerId: file.containerId } : {}),
        ...(file.containerName ? { containerName: file.containerName } : {}),
        source: file.source,
        path: file.path,
        kind: file.kind
    };
}

function renderManagedTraefikStaticConfig(content: string, defaults: TraefikDefaultsPayload) {
    const block = /\.(toml)$/i.test(defaultsConfigPathHint(content)) ? renderManagedTraefikToml(defaults) : renderManagedTraefikYaml(defaults);
    const start = "# deploy-managed-defaults:start";
    const end = "# deploy-managed-defaults:end";
    const managed = `${start}\n${block.trim()}\n${end}`;
    const normalized = content.trimEnd();
    const pattern = new RegExp(`${escapeRegExp(start)}[\\s\\S]*?${escapeRegExp(end)}`, "m");
    if (pattern.test(content)) {
        return content.replace(pattern, managed);
    }
    return `${normalized}${normalized ? "\n\n" : ""}${managed}\n`;
}

function defaultsConfigPathHint(content: string) {
    return /^\s*\[/.test(content) ? "traefik.toml" : "traefik.yml";
}

function renderManagedTraefikYaml(defaults: TraefikDefaultsPayload) {
    const entryPoints = splitCsv(defaults.entryPoints || "websecure");
    const certResolver = defaults.certResolver?.trim() || "letsencrypt";
    const network = defaults.network?.trim() || "proxy";
    const acmeStorage = defaults.acmeStorage?.trim() || "/letsencrypt/acme.json";
    const acmeEmail = defaults.acmeEmail?.trim();
    const lines = [
        "entryPoints:",
        ...entryPoints.flatMap((entryPoint) => [
            `  ${yamlConfigKey(entryPoint)}:`,
            "    address: \":443\""
        ]),
        "providers:",
        "  docker:",
        "    exposedByDefault: false",
        `    network: ${yamlScalar(network)}`,
        "  swarm:",
        "    exposedByDefault: false",
        `    network: ${yamlScalar(network)}`,
        "certificatesResolvers:",
        `  ${yamlConfigKey(certResolver)}:`,
        "    acme:",
        ...(acmeEmail ? [`      email: ${yamlScalar(acmeEmail)}`] : []),
        `      storage: ${yamlScalar(acmeStorage)}`,
        "      httpChallenge:",
        `        entryPoint: ${yamlScalar(entryPoints[0] || "websecure")}`
    ];
    return lines.join("\n");
}

function renderManagedTraefikToml(defaults: TraefikDefaultsPayload) {
    const entryPoints = splitCsv(defaults.entryPoints || "websecure");
    const certResolver = defaults.certResolver?.trim() || "letsencrypt";
    const network = defaults.network?.trim() || "proxy";
    const acmeStorage = defaults.acmeStorage?.trim() || "/letsencrypt/acme.json";
    const acmeEmail = defaults.acmeEmail?.trim();
    return [
        ...entryPoints.flatMap((entryPoint) => [
            `[entryPoints.${entryPoint}]`,
            "  address = \":443\"",
            ""
        ]),
        "[providers.docker]",
        "  exposedByDefault = false",
        `  network = ${JSON.stringify(network)}`,
        "",
        "[providers.swarm]",
        "  exposedByDefault = false",
        `  network = ${JSON.stringify(network)}`,
        "",
        `[certificatesResolvers.${certResolver}.acme]`,
        ...(acmeEmail ? [`  email = ${JSON.stringify(acmeEmail)}`] : []),
        `  storage = ${JSON.stringify(acmeStorage)}`,
        "",
        `[certificatesResolvers.${certResolver}.acme.httpChallenge]`,
        `  entryPoint = ${JSON.stringify(entryPoints[0] || "websecure")}`
    ].join("\n");
}

function splitCsv(value: string) {
    return unique(value.split(",").map((item) => item.trim()).filter(Boolean));
}

function yamlConfigKey(value: string) {
    return /^[A-Za-z0-9_-]+$/.test(value) ? value : yamlScalar(value);
}

async function writeMountedTraefikConfig(file: TraefikConfigBackupFile, content: string) {
    const mountTarget = file.mountTarget || file.path;
    const isFileMount = mountTarget === file.path;
    const targetPath = isFileMount ? "/mnt/deploy-target" : `/mnt/deploy-target/${relativeContainerPath(mountTarget, file.path)}`;
    const backupSuffix = new Date().toISOString().replace(/[:.]/g, "-");
    const script = [
        "set -eu",
        "target=\"$1\"",
        "mkdir -p \"$(dirname \"$target\")\"",
        "if [ -f \"$target\" ]; then cp \"$target\" \"$target.deploy-backup-$2\"; fi",
        "cat > \"$target\""
    ].join("\n");

    await runDockerWrite(
        ["run", "--rm", "-i", "-v", `${file.source}:/mnt/deploy-target`, "alpine:latest", "sh", "-c", script, "sh", targetPath, backupSuffix],
        content
    );
}

function relativeContainerPath(mountTarget: string, path: string) {
    const normalizedMount = mountTarget.replace(/\/+$/, "");
    const normalizedPath = path.replace(/\/+$/, "");
    if (normalizedPath === normalizedMount) {
        return ".";
    }
    if (!normalizedPath.startsWith(`${normalizedMount}/`)) {
        throw new Error(`Discovered Traefik config path ${path} is not inside mount ${mountTarget}.`);
    }
    return normalizedPath.slice(normalizedMount.length + 1);
}

function runDockerWrite(args: string[], input: string) {
    return new Promise<void>((resolve, reject) => {
        const child = spawn("docker", args, { stdio: ["pipe", "pipe", "pipe"] });
        let stderr = "";
        child.stderr?.on("data", (chunk: Buffer | string) => {
            stderr += String(chunk);
        });
        child.on("error", reject);
        child.on("close", (code) => {
            if (code === 0) {
                resolve();
            } else {
                reject(new Error(stderr.trim() || `Docker writer exited with code ${code}.`));
            }
        });
        child.stdin?.end(input);
    });
}

function parseYamlTopLevelObjectKeys(content: string, key: string) {
    const lines = content.split(/\r?\n/);
    const startIndex = lines.findIndex((line) => line.trim() === `${key}:` && countIndent(line) === 0);
    if (startIndex === -1) {
        return [];
    }

    const keys: string[] = [];
    for (const line of lines.slice(startIndex + 1)) {
        const indent = countIndent(line);
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) {
            continue;
        }
        if (indent === 0) {
            break;
        }
        if (indent === 2 && /^[A-Za-z0-9_.-]+:\s*$/.test(trimmed)) {
            keys.push(trimmed.slice(0, -1));
        }
    }

    return keys;
}

function parseYamlNestedScalar(content: string, path: string[]) {
    const lines = content.split(/\r?\n/);
    let startIndex = 0;
    let parentIndent = -1;
    for (let level = 0; level < path.length - 1; level += 1) {
        const foundIndex = lines.findIndex((line, index) => {
            if (index < startIndex) {
                return false;
            }

            const trimmed = line.trim();
            const indent = countIndent(line);
            if (!trimmed || trimmed.startsWith("#")) {
                return false;
            }
            if (parentIndent >= 0 && indent <= parentIndent) {
                return false;
            }

            return trimmed === `${path[level]}:`;
        });
        if (foundIndex === -1) {
            return "";
        }
        parentIndent = countIndent(lines[foundIndex]);
        startIndex = foundIndex + 1;
    }

    const target = path.at(-1);
    for (const line of lines.slice(startIndex)) {
        const indent = countIndent(line);
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) {
            continue;
        }
        if (indent <= parentIndent) {
            break;
        }
        if (trimmed.startsWith(`${target}:`)) {
            return unquoteConfigScalar(trimmed.slice(String(target).length + 1));
        }
    }

    return "";
}

function hasYamlPath(content: string, path: string[]) {
    if (!path.length) {
        return false;
    }

    const lines = content.split(/\r?\n/);
    let startIndex = 0;
    let parentIndent = -1;
    for (const key of path) {
        const foundIndex = lines.findIndex((line, index) => {
            if (index < startIndex) {
                return false;
            }
            const trimmed = line.trim();
            const indent = countIndent(line);
            if (!trimmed || trimmed.startsWith("#")) {
                return false;
            }
            if (parentIndent >= 0 && indent <= parentIndent) {
                return false;
            }
            return trimmed === `${key}:` || trimmed.startsWith(`${key}: `);
        });
        if (foundIndex === -1) {
            return false;
        }
        parentIndent = countIndent(lines[foundIndex]);
        startIndex = foundIndex + 1;
    }
    return true;
}

function parseYamlAcmeStorage(content: string) {
    for (const resolver of parseYamlTopLevelObjectKeys(content, "certificatesResolvers")) {
        const storage = parseYamlNestedScalar(content, ["certificatesResolvers", resolver, "acme", "storage"]);
        if (storage) {
            return storage;
        }
    }

    return "";
}

function parseTomlSectionKeys(content: string, section: string) {
    const pattern = new RegExp(`^\\[${escapeRegExp(section)}\\.([^\\.\\]]+)`, "gm");
    return unique([...content.matchAll(pattern)].map((match) => match[1]));
}

function parseTomlScalar(content: string, section: string, key: string) {
    const sectionPattern = new RegExp(`^\\[${escapeRegExp(section)}\\]\\s*$([\\s\\S]*?)(?=^\\[|(?![\\s\\S]))`, "m");
    const sectionMatch = content.match(sectionPattern);
    const body = sectionMatch?.[1] ?? "";
    const valueMatch = body.match(new RegExp(`^\\s*${escapeRegExp(key)}\\s*=\\s*(.+?)\\s*$`, "m"));
    return valueMatch ? unquoteConfigScalar(valueMatch[1]) : "";
}

function hasTomlSection(content: string, section: string) {
    return new RegExp(`^\\[${escapeRegExp(section)}\\]\\s*$`, "m").test(content);
}

function parseTomlAcmeStorage(content: string) {
    const match = content.match(/^\[certificatesResolvers\.[^.]+\.(?:acme|ACME)\]\s*$([\s\S]*?)(?=^\[|(?![\s\S]))/m);
    const body = match?.[1] ?? "";
    const valueMatch = body.match(/^\s*storage\s*=\s*(.+?)\s*$/m);
    return valueMatch ? unquoteConfigScalar(valueMatch[1]) : "";
}

function countIndent(line: string) {
    return line.match(/^ */)?.[0].length ?? 0;
}

function unquoteConfigScalar(value: string) {
    const trimmed = value.trim().replace(/\s+#.*$/, "");
    if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
        return trimmed.slice(1, -1);
    }

    return trimmed;
}

function escapeRegExp(value: string) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractTraefikKeys(args: string[], pattern: RegExp) {
    return unique(args.flatMap((arg) => arg.match(pattern)?.[1] ?? []));
}

function extractTraefikValue(args: string[], prefix: string, suffix = "") {
    const arg = args.find((candidate) => candidate.startsWith(prefix) && (!suffix || candidate.includes(suffix)));
    if (!arg) {
        return "";
    }

    return suffix ? arg.slice(arg.indexOf(suffix) + suffix.length) : arg.slice(prefix.length);
}

function isLikelyTraefikStaticConfigPath(path: string) {
    return /traefik\.ya?ml$|traefik\.toml$/.test(path);
}

function isLikelyTraefikDynamicConfigPath(path: string) {
    return /dynamic|\/conf(?:ig)?\.d\//i.test(path);
}

function unique(values: string[]) {
    return [...new Set(values.filter(Boolean))].sort((left, right) => left.localeCompare(right));
}

/**
 * Inspects containers that Docker Compose created for one deployed project.
 */
export async function inspectProjectStatus(repoName: string, appSettings: ProjectSettings, globalSettings: GlobalSettings): Promise<RuntimeStatus> {
    const hostAppsPath = appSettings.path ?? defaultProjectPath(globalSettings, repoName);
    const composeProjectName = basename(hostAppsPath.replace(/\/+$/, "")) || repoName;
    if (appSettings.deploymentStrategy === "swarm") {
        return inspectSwarmProjectStatus(composeProjectName);
    }

    const projectLabel = `label=com.docker.compose.project=${composeProjectName}`;

    try {
        const { stdout: idsOutput, stderr: idsError } = await execAsync(
            `docker ps -aq --filter ${shellQuote(projectLabel)}`,
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

        const services = (JSON.parse(stdout.trim()) as DockerInspectContainer[]).map((container) => parseRuntimeService(container, composeProjectName));

        return {
            status: summarizeRuntimeStatus(services),
            checkedAt: new Date().toISOString(),
            services
        };
    } catch (error) {
        return runtimeError(error instanceof Error ? error.message : "Could not inspect runtime status.");
    }
}

async function inspectSwarmProjectStatus(composeProjectName: string): Promise<RuntimeStatus> {
    try {
        const { stdout: idsOutput, stderr: idsError } = await execAsync(
            `docker service ls -q --filter ${shellQuote(`label=com.docker.stack.namespace=${composeProjectName}`)}`,
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
            `docker service inspect ${ids.map(shellQuote).join(" ")}`,
            { maxBuffer: 2 * 1024 * 1024 }
        );
        if (stderr.trim()) {
            return runtimeError(stderr.trim());
        }

        const inspectedServices = JSON.parse(stdout.trim()) as DockerInspectService[];
        const taskCounts = await inspectSwarmServiceTasks(inspectedServices);
        const services = inspectedServices.map((service) => parseRuntimeSwarmService(service, composeProjectName, taskCounts[service.ID ?? ""]));

        return {
            status: summarizeRuntimeStatus(services),
            checkedAt: new Date().toISOString(),
            services
        };
    } catch (error) {
        return runtimeError(error instanceof Error ? error.message : "Could not inspect Swarm runtime status.");
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
                    TRAEFIK_IDS="$(docker ps -q --filter label=com.docker.swarm.service.name=traefik)"
                fi
                if [ -z "$TRAEFIK_IDS" ]; then
                    TRAEFIK_IDS="$(docker ps -q --filter label=com.docker.stack.namespace=traefik)"
                fi
                if [ -z "$TRAEFIK_IDS" ]; then
                    TRAEFIK_IDS="$(docker ps --format '{{.ID}} {{.Image}} {{.Names}} {{.Label "com.docker.swarm.service.name"}} {{.Label "com.docker.stack.namespace"}}' | grep -Ei '(^|[ /_])traefik(:| |$|_)' | awk '{print $1}')"
                fi
                if [ -z "$TRAEFIK_IDS" ]; then
                    TRAEFIK_IDS="$(docker ps --format '{{.ID}} {{.Image}} {{.Names}}' | grep -Ei '(^|[ /])traefik(:| |$)' | awk '{print $1}')"
                fi
                TRAEFIK_SERVICE_IDS="$(docker service ls --format '{{.ID}} {{.Image}} {{.Name}}' 2>/dev/null | grep -Ei '(^|[ /])traefik(:| |$)' | awk '{print $1}')"
                TARGET_ID="$(docker ps -q --filter ${shellQuote(`label=com.docker.compose.project=${composeProjectName}`)} --filter ${shellQuote(`label=com.docker.compose.service=${serviceName}`)} | head -n 1)"
                NETWORK_PRESENT="$(docker network inspect ${shellQuote(network)} > /dev/null 2>&1 && echo true || echo false)"
                NETWORK_ID=""
                NETWORK_DRIVER=""
                NETWORK_SCOPE=""
                NETWORK_ATTACHABLE=""
                if [ "$NETWORK_PRESENT" = "true" ]; then
                    NETWORK_ID="$(docker network inspect ${shellQuote(network)} --format '{{.Id}}' 2>/dev/null || true)"
                    NETWORK_DRIVER="$(docker network inspect ${shellQuote(network)} --format '{{.Driver}}' 2>/dev/null || true)"
                    NETWORK_SCOPE="$(docker network inspect ${shellQuote(network)} --format '{{.Scope}}' 2>/dev/null || true)"
                    NETWORK_ATTACHABLE="$(docker network inspect ${shellQuote(network)} --format '{{.Attachable}}' 2>/dev/null || true)"
                fi
                TRAEFIK_ON_NETWORK=false
                TARGET_ON_NETWORK=false
                if [ -n "$TRAEFIK_IDS" ]; then
                    for id in $TRAEFIK_IDS; do
                        if docker inspect "$id" --format '{{json .NetworkSettings.Networks}}' | grep -q ${shellQuote(`"${network}"`)}; then
                            TRAEFIK_ON_NETWORK=true
                        fi
                    done
                fi
                if [ -n "$TRAEFIK_SERVICE_IDS" ]; then
                    for id in $TRAEFIK_SERVICE_IDS; do
                        SERVICE_NETWORKS="$(docker service inspect "$id" --format '{{json .Spec.TaskTemplate.Networks}} {{json .Endpoint.VirtualIPs}}' 2>/dev/null || true)"
                        if echo "$SERVICE_NETWORKS" | grep -q "$NETWORK_ID"; then
                            TRAEFIK_ON_NETWORK=true
                        fi
                    done
                fi
                if [ -n "$TARGET_ID" ]; then
                    if docker inspect "$TARGET_ID" --format '{{json .NetworkSettings.Networks}}' | grep -q ${shellQuote(`"${network}"`)}; then
                        TARGET_ON_NETWORK=true
                    fi
                fi
                ATTACHABLE=false
                ATTACH_EXIT=125
                ATTACH_OUTPUT=""
                if [ "$NETWORK_PRESENT" = "true" ]; then
                    ATTACH_OUTPUT="$(timeout 20 docker run --rm --network ${shellQuote(network)} alpine:latest sh -c true 2>&1)"
                    ATTACH_EXIT=$?
                    if [ "$ATTACH_EXIT" -eq 0 ]; then
                        ATTACHABLE=true
                    fi
                fi
                REACHABLE=false
                REACH_EXIT=125
                REACH_OUTPUT=""
                if [ "$NETWORK_PRESENT" = "true" ] && [ "$ATTACHABLE" = "true" ]; then
                    REACH_OUTPUT="$(docker run --rm --network ${shellQuote(network)} alpine:latest wget -T 5 -qO- ${shellQuote(url)} >/dev/null 2>&1)"
                    REACH_EXIT=$?
                    if [ "$REACH_EXIT" -eq 0 ] || echo "$REACH_OUTPUT" | grep -Eiq 'server returned error|404|401|403|500'; then
                        REACHABLE=true
                    fi
                fi
                echo "traefikContainerCount=$(printf "%s\\n" "$TRAEFIK_IDS" | sed '/^$/d' | wc -l | tr -d ' ')"
                echo "traefikServiceCount=$(printf "%s\\n" "$TRAEFIK_SERVICE_IDS" | sed '/^$/d' | wc -l | tr -d ' ')"
                echo "targetPresent=$([ -n "$TARGET_ID" ] && echo true || echo false)"
                echo "networkPresent=$NETWORK_PRESENT"
                echo "networkDriver=$NETWORK_DRIVER"
                echo "networkScope=$NETWORK_SCOPE"
                echo "networkAttachable=$NETWORK_ATTACHABLE"
                echo "traefikOnNetwork=$TRAEFIK_ON_NETWORK"
                echo "targetOnNetwork=$TARGET_ON_NETWORK"
                echo "attachable=$ATTACHABLE"
                echo "attachExit=$ATTACH_EXIT"
                printf "attachOutput=%s\\n" "$ATTACH_OUTPUT"
                echo "reachable=$REACHABLE"
                echo "reachExit=$REACH_EXIT"
                printf "reachOutput=%s\\n" "$REACH_OUTPUT"
EOF`;

    try {
        const { stdout } = await execAsync(dockerRunCommand, { maxBuffer: 2 * 1024 * 1024 });
        const raw = parseKeyValueOutput(stdout);
        const traefikContainerCount = Number(raw.traefikContainerCount || 0);
        const traefikServiceCount = Number(raw.traefikServiceCount || 0);
        const networkPresent = outputFlag(raw.networkPresent);
        const networkAttachWorks = outputFlag(raw.attachable);
        const traefikOnNetwork = outputFlag(raw.traefikOnNetwork);
        const targetPresent = outputFlag(raw.targetPresent);
        const targetOnNetwork = outputFlag(raw.targetOnNetwork);
        const reachable = outputFlag(raw.reachable);
        const traefikWorkloadCount = traefikContainerCount + traefikServiceCount;
        const localTraefikStatus: TraefikDiagnosticStatus = traefikWorkloadCount > 0 ? "pass" : "warn";
        const localTraefikNetworkStatus: TraefikDiagnosticStatus = traefikOnNetwork ? "pass" : "warn";
        const checks: TraefikDiagnosticCheck[] = [
            {
                key: "traefik-workload",
                label: "Traefik workload",
                status: localTraefikStatus,
                detail: traefikWorkloadCount > 0
                    ? `${traefikContainerCount} container(s), ${traefikServiceCount} Swarm service(s) found.`
                    : "No local Traefik workload was found on this Docker node. This is OK when Traefik runs on another Swarm node and uses the same overlay network."
            },
            {
                key: "network-present",
                label: "Docker network",
                status: networkPresent ? "pass" : "fail",
                detail: networkPresent
                    ? `${network} exists${raw.networkDriver || raw.networkScope ? ` (${[raw.networkDriver, raw.networkScope].filter(Boolean).join(", ")}, attachable=${raw.networkAttachable || "unknown"})` : ""}.`
                    : `${network} does not exist on the target Docker host.`
            },
            {
                key: "network-attach",
                label: "Container network attach",
                status: networkAttachWorks ? "pass" : "fail",
                detail: networkAttachWorks
                    ? `A normal Docker container can attach to ${network}.`
                    : `A normal Docker container could not attach to ${network}${raw.attachOutput ? `: ${raw.attachOutput}` : "."}`
            },
            {
                key: "traefik-network",
                label: "Traefik network membership",
                status: localTraefikNetworkStatus,
                detail: traefikOnNetwork
                    ? `A local Traefik workload is attached to ${network}.`
                    : `No local Traefik workload attached to ${network} was found on this node. For Swarm, Traefik may run on another node; the critical check here is whether this app can attach to ${network}.`
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
    const hostAppsPath = appSettings.path ?? defaultProjectPath(globalSettings, repoName);
    const composeProjectName = basename(hostAppsPath.replace(/\/+$/, "")) || repoName;
    if (appSettings.deploymentStrategy === "swarm") {
        const serviceName = normalizeRuntimeActionInput(service, "restart");
        const serviceRef = `${composeProjectName}_${serviceName}`;
        const dockerRunCommand = `docker run -i --rm \
            -v /var/run/docker.sock:/var/run/docker.sock \
            alpine:latest sh << 'EOF'
                apk add --no-cache docker-cli > /dev/null 2>&1
                docker service logs --tail ${safeTail} ${shellQuote(serviceRef)}
EOF`;
        const { stdout, stderr } = await execAsync(dockerRunCommand, { maxBuffer: 4 * 1024 * 1024 });
        return {
            service: serviceName,
            containerId: serviceRef,
            tail: safeTail,
            checkedAt: new Date().toISOString(),
            output: `${stdout}${stderr ? `\n${stderr}` : ""}`
        };
    }

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
    const hostAppsPath = appSettings.path ?? defaultProjectPath(globalSettings, repoName);
    const composeProjectName = basename(hostAppsPath.replace(/\/+$/, "")) || repoName;
    if (appSettings.deploymentStrategy === "swarm") {
        const serviceName = normalizeRuntimeActionInput(service, "restart");
        const serviceRef = `${composeProjectName}_${serviceName}`;
        const worker = spawn("docker", [
            "run",
            "-i",
            "--rm",
            "-v",
            "/var/run/docker.sock:/var/run/docker.sock",
            "alpine:latest",
            "sh",
            "-c",
            `apk add --no-cache docker-cli > /dev/null 2>&1 && docker service logs --follow --tail ${safeTail} ${shellQuote(serviceRef)}`
        ], { stdio: ["ignore", "pipe", "pipe"] });
        return wireRuntimeLogWorker(worker, hooks);
    }

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
    const actionScript = appSettings.deploymentStrategy === "swarm"
        ? renderSwarmServiceActionScript(composeProjectName, serviceName, action)
        : renderRuntimeServiceActionScript(serviceName, action);

    return `docker run -i --rm \
            -v /var/run/docker.sock:/var/run/docker.sock \
            -v ${shellQuote(`${projectPath}:${projectPath}`)} \
            alpine:latest sh << 'EOF'
                apk add --no-cache docker-cli docker-cli-compose > /dev/null 2>&1
                PROJECT_ROOT=${shellQuote(projectPath)}
                PROJECT_NAME=${shellQuote(composeProjectName)}
                COMPOSE_WORKSPACE="$PROJECT_ROOT/.updater/compose"

                if [ ${shellQuote(appSettings.deploymentStrategy === "swarm" ? "true" : "")} = "true" ]; then
${actionScript}
                    exit $?
                fi

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
                    mkdir -p "$COMPOSE_WORKSPACE"
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

function renderSwarmServiceActionScript(projectName: string, service: string, action: RuntimeServiceAction) {
    const serviceRef = shellQuote(`${projectName}_${service}`);
    if (action === "restart" || action === "recreate" || action === "pull") {
        return `
                echo "--> Updating Swarm service ${service}..."
                docker service update --force ${serviceRef}`;
    }

    if (action === "start") {
        return `
                echo "--> Scaling Swarm service ${service} to 1..."
                docker service scale ${serviceRef}=1`;
    }

    return `
                echo "--> Scaling Swarm service ${service} to 0..."
                docker service scale ${serviceRef}=0`;
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
type DockerServicePorts = Array<{ Protocol?: string; TargetPort?: number; PublishedPort?: number; PublishMode?: string }>;

interface DockerInspectContainer {
    Id?: string;
    Name?: string;
    Args?: string[];
    Config?: {
        Image?: string;
        Cmd?: string[];
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

interface DockerInspectContainerWithMounts extends DockerInspectContainer {
    Mounts?: Array<{
        Type?: string;
        Source: string;
        Destination: string;
    }>;
}

interface DockerInspectService {
    ID?: string;
    Spec?: {
        Name?: string;
        Labels?: Record<string, string>;
        Mode?: {
            Replicated?: {
                Replicas?: number;
            };
            Global?: Record<string, unknown>;
        };
        TaskTemplate?: {
            ContainerSpec?: {
                Image?: string;
                Args?: string[];
                Command?: string[];
                Mounts?: Array<{
                    Type?: string;
                    Source: string;
                    Target: string;
                }>;
            };
            Networks?: Array<{
                Target: string;
                Aliases?: string[];
            }>;
        };
    };
    Endpoint?: {
        Ports?: DockerServicePorts;
        VirtualIPs?: Array<{
            NetworkID: string;
            Addr?: string;
        }>;
    };
    ServiceStatus?: {
        RunningTasks?: number;
        DesiredTasks?: number;
    };
}

interface DockerInspectNetwork {
    Id?: string;
    Name: string;
    Driver?: string;
    Scope?: string;
    Attachable?: boolean;
    Ingress?: boolean;
}

function parseRuntimeService(container: DockerInspectContainer, projectName = ""): RuntimeServiceStatus {
    const ports = formatPublishedPorts(container.NetworkSettings?.Ports);
    const exposedPorts = Object.keys(container.Config?.ExposedPorts ?? {});
    const networks = Object.keys(container.NetworkSettings?.Networks ?? {});
    const networkMode = container.HostConfig?.NetworkMode || "unknown";
    const containerName = container.Name?.replace(/^\/+/, "");
    const labels = container.Config?.Labels ?? {};
    const swarmService = labels["com.docker.swarm.service.name"];
    const swarmServiceName = projectName && swarmService?.startsWith(`${projectName}_`) ? swarmService.slice(projectName.length + 1) : swarmService;

    return {
        service: labels["com.docker.compose.service"] || swarmServiceName || containerName || container.Id || "unknown",
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

async function inspectSwarmServiceTasks(services: DockerInspectService[]) {
    const result: Record<string, { running: number; desired: number; states: string[] }> = {};
    await Promise.all(services.map(async (service) => {
        const serviceId = service.ID;
        if (!serviceId) {
            return;
        }

        try {
            const { stdout } = await execAsync(
                `docker service ps ${shellQuote(serviceId)} --no-trunc --format '{{json .}}'`,
                { maxBuffer: 1024 * 1024 }
            );
            const tasks = stdout
                .split(/\r?\n/)
                .map((line) => line.trim())
                .filter(Boolean)
                .map((line) => {
                    try {
                        return JSON.parse(line) as { CurrentState?: string; DesiredState?: string; Error?: string; Name?: string };
                    } catch {
                        return null;
                    }
                })
                .filter((task): task is { CurrentState?: string; DesiredState?: string; Error?: string; Name?: string } => Boolean(task));
            const activeTasks = tasks.filter((task) => !/shutdown/i.test(task.DesiredState ?? ""));
            result[serviceId] = {
                running: activeTasks.filter((task) => /^running/i.test(task.CurrentState ?? "")).length,
                desired: activeTasks.length,
                states: activeTasks.map((task) => task.CurrentState || task.DesiredState || task.Error || "unknown").filter(Boolean)
            };
        } catch {
            result[serviceId] = { running: 0, desired: 0, states: [] };
        }
    }));
    return result;
}

function parseRuntimeSwarmService(service: DockerInspectService, projectName: string, taskCounts?: { running: number; desired: number; states: string[] }): RuntimeServiceStatus {
    const serviceName = service.Spec?.Name ?? service.ID ?? "unknown";
    const shortName = serviceName.startsWith(`${projectName}_`) ? serviceName.slice(projectName.length + 1) : serviceName;
    const desired = service.ServiceStatus?.DesiredTasks ?? taskCounts?.desired ?? service.Spec?.Mode?.Replicated?.Replicas ?? 0;
    const running = service.ServiceStatus?.RunningTasks ?? taskCounts?.running ?? 0;
    const state = desired > 0 && running === desired ? "running" : running > 0 ? "partial" : "stopped";
    const networks = unique([
        ...(service.Spec?.TaskTemplate?.Networks ?? []).map((network) => network.Target).filter(Boolean),
        ...(service.Endpoint?.VirtualIPs ?? []).map((network) => network.NetworkID).filter(Boolean)
    ]);
    const ports = formatServicePorts(service.Endpoint?.Ports);

    return {
        service: shortName,
        ...(service.ID ? { containerId: service.ID.slice(0, 12) } : {}),
        state: taskCounts?.states.length ? `${state} (${running}/${desired}: ${taskCounts.states.join(", ")})` : state,
        ...(service.Spec?.TaskTemplate?.ContainerSpec?.Image ? { image: service.Spec.TaskTemplate.ContainerSpec.Image } : {}),
        ...(ports ? { ports } : {}),
        networkMode: "swarm",
        ...(networks.length ? { networks } : {})
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

function formatServicePorts(ports: DockerServicePorts | undefined) {
    return (ports ?? [])
        .map((port) => {
            const protocol = port.Protocol ? `/${port.Protocol}` : "";
            const mode = port.PublishMode ? ` (${port.PublishMode})` : "";
            if (port.PublishedPort && port.TargetPort) {
                return `${port.PublishedPort}->${port.TargetPort}${protocol}${mode}`;
            }
            if (port.TargetPort) {
                return `${port.TargetPort}${protocol}${mode}`;
            }
            return "";
        })
        .filter(Boolean)
        .join(", ");
}

function summarizeRuntimeStatus(services: RuntimeServiceStatus[]) {
    if (services.length === 0) {
        return "unknown";
    }

    const running = services.filter((service) => service.state.toLowerCase().startsWith("running")).length;
    if (running === services.length) {
        return "running";
    }

    if (services.some((service) => service.state.toLowerCase().startsWith("partial"))) {
        return "partial";
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

function summarizeValidationStatus(checks: TraefikConfigValidationCheck[]) {
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
