/**
 * Makes a project-root .env available to Docker Compose commands executed from
 * a Deploy-managed temporary checkout.
 */
export function renderProjectRootEnvFileScript(envFilePath?: string) {
    const configuredEnvFilePath = envFilePath?.trim() ?? "";
    const configuredEnvFile = configuredEnvFilePath ? shellQuoteForScript(configuredEnvFilePath) : "''";
    return `
                CONFIGURED_ENV_FILE=${configuredEnvFile}
                if [ -n "$CONFIGURED_ENV_FILE" ]; then
                    case "$CONFIGURED_ENV_FILE" in
                        /*) ENV_FILE="$CONFIGURED_ENV_FILE" ;;
                        *) ENV_FILE="$PROJECT_ROOT/$CONFIGURED_ENV_FILE" ;;
                    esac
                    if [ ! -f "$ENV_FILE" ]; then
                        echo "--> CRITICAL: Configured Compose env file does not exist: $ENV_FILE"
                        exit 1
                    fi
                    if [ "$PWD" != "$PROJECT_ROOT" ]; then
                        rm -f .env
                        ln -s "$ENV_FILE" .env
                    elif [ ! -e .env ]; then
                        ln -s "$ENV_FILE" .env
                    fi
                    if [ ! -e "$PROJECT_ROOT/.env" ]; then
                        ln -s "$ENV_FILE" "$PROJECT_ROOT/.env"
                    fi
                    echo "--> Using configured Compose env file: $ENV_FILE"
                elif [ -f "$PROJECT_ROOT/.env" ] && [ ! -e .env ]; then
                    echo "--> Using project-root .env for Compose."
                    ln -s "$PROJECT_ROOT/.env" .env
                fi`;
}

/**
 * Makes an absolute env file outside the project-root bind mount visible to a
 * temporary Compose worker. Relative paths already live inside the project
 * root mount and do not need an additional volume.
 */
export function renderEnvFileVolume(envFilePath: string | undefined, projectRoot: string) {
    const envPath = envFilePath?.trim() ?? "";
    const root = projectRoot.replace(/\/+$/, "");
    if (!envPath.startsWith("/") || envPath === root || envPath.startsWith(`${root}/`)) {
        return "";
    }

    return envPath + ":" + envPath + ":ro";
}

function shellQuoteForScript(value: string) {
    return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Rewrites build contexts that still point at the persistent project root so
 * Docker builds from the temporary checkout instead of the data/workspace root.
 */
export function renderTempBuildContextRewriteScript() {
    return `
                PROJECT_ROOT_NO_SLASH="\${PROJECT_ROOT%/}"
                TMP_DEPLOY_NO_SLASH="\${TMP_DEPLOY%/}"
                for COMPOSE_REWRITE_FILE in docker-compose.updater.yml docker-compose.yaml docker-compose.yml compose.yaml compose.yml; do
                    if [ ! -f "$COMPOSE_REWRITE_FILE" ]; then
                        continue
                    fi
                    echo "--> Rewriting project-root build contexts in $COMPOSE_REWRITE_FILE."
                    sed -i.bak \\
                        -e "s|^\\([[:space:]]*context:[[:space:]]*\\)$PROJECT_ROOT_NO_SLASH/|\\1$TMP_DEPLOY_NO_SLASH/|" \\
                        -e "s|^\\([[:space:]]*context:[[:space:]]*\\)$PROJECT_ROOT_NO_SLASH/\\{0,1\\}\\([[:space:]]*\\)$|\\1$TMP_DEPLOY_NO_SLASH\\2|" \\
                        -e "s|^\\([[:space:]]*context:[[:space:]]*\\)$PROJECT_ROOT_NO_SLASH/\\{0,1\\}\\([[:space:]]*#.*\\)$|\\1$TMP_DEPLOY_NO_SLASH\\2|" \\
                        -e "s|^\\([[:space:]]*build:[[:space:]]*\\)$PROJECT_ROOT_NO_SLASH/|\\1$TMP_DEPLOY_NO_SLASH/|" \\
                        -e "s|^\\([[:space:]]*build:[[:space:]]*\\)$PROJECT_ROOT_NO_SLASH/\\{0,1\\}\\([[:space:]]*\\)$|\\1$TMP_DEPLOY_NO_SLASH\\2|" \\
                        -e "s|^\\([[:space:]]*build:[[:space:]]*\\)$PROJECT_ROOT_NO_SLASH/\\{0,1\\}\\([[:space:]]*#.*\\)$|\\1$TMP_DEPLOY_NO_SLASH\\2|" \\
                        "$COMPOSE_REWRITE_FILE"
                    rm -f "$COMPOSE_REWRITE_FILE.bak"
                done`;
}

/**
 * Rewrites relative bind mount sources to the persistent project root before
 * Compose expands them against the temporary checkout directory.
 */
export function renderProjectRootBindMountRewriteScript() {
    return `
                PROJECT_ROOT_NO_SLASH="\${PROJECT_ROOT%/}"
                for COMPOSE_REWRITE_FILE in docker-compose.updater.yml docker-compose.yaml docker-compose.yml compose.yaml compose.yml; do
                    if [ ! -f "$COMPOSE_REWRITE_FILE" ]; then
                        continue
                    fi
                    echo "--> Rewriting relative bind mounts in $COMPOSE_REWRITE_FILE to the project root."
                    sed -i.bak \\
                        -e "s|^\\([[:space:]]*-[[:space:]]*\\)\\\"\\./\\([^:][^:]*:[^\\\"]*\\)\\\"\\([[:space:]]*\\)$|\\1\\\"$PROJECT_ROOT_NO_SLASH/\\2\\\"\\3|" \\
                        -e "s|^\\([[:space:]]*-[[:space:]]*\\)'\\./\\([^:][^:]*:[^']*\\)'\\([[:space:]]*\\)$|\\1'$PROJECT_ROOT_NO_SLASH/\\2'\\3|" \\
                        -e "s|^\\([[:space:]]*-[[:space:]]*\\)\\./\\([^:][^:]*:.*\\)$|\\1$PROJECT_ROOT_NO_SLASH/\\2|" \\
                        -e "s|^\\([[:space:]]*source:[[:space:]]*\\)\\\"\\./\\([^\\\"]*\\)\\\"\\([[:space:]]*\\)$|\\1\\\"$PROJECT_ROOT_NO_SLASH/\\2\\\"\\3|" \\
                        -e "s|^\\([[:space:]]*source:[[:space:]]*\\)'\\./\\([^']*\\)'\\([[:space:]]*\\)$|\\1'$PROJECT_ROOT_NO_SLASH/\\2'\\3|" \\
                        -e "s|^\\([[:space:]]*source:[[:space:]]*\\)\\./\\([^[:space:]]*\\)\\([[:space:]]*\\)$|\\1$PROJECT_ROOT_NO_SLASH/\\2\\3|" \\
                        "$COMPOSE_REWRITE_FILE"
                    rm -f "$COMPOSE_REWRITE_FILE.bak"
                done`;
}

/**
 * Rewrites the final Deploy-owned compose file after Docker Compose has
 * rendered absolute paths. Runtime bind mounts under common data directories
 * are externalized to the project root. Read-only checkout-local mounts are
 * moved to a stable Deploy release checkout. Writable checkout-local mounts
 * that are not clearly data paths are left untouched so the guard fails before
 * containers are replaced.
 */
export function renderPersistedStorageRewriteScript(targetFile: string) {
    return `
                if [ -f ${targetFile} ] && [ -n "$TMP_DEPLOY" ] && [ -n "$RELEASE_DEPLOY" ]; then
                    PROJECT_ROOT_NO_SLASH="\${PROJECT_ROOT%/}"
                    TMP_DEPLOY_NO_SLASH="\${TMP_DEPLOY%/}"
                    RELEASE_DEPLOY_NO_SLASH="\${RELEASE_DEPLOY%/}"
                    echo "--> Rewriting persisted temporary-checkout paths."
                    if docker compose -f ${targetFile} config --format json > /tmp/deploy-compose-persisted-before.json 2> /tmp/deploy-compose-persisted-rewrite-error.txt; then
                        node - "$PROJECT_ROOT_NO_SLASH" "$TMP_DEPLOY_NO_SLASH" "$RELEASE_DEPLOY_NO_SLASH" /tmp/deploy-compose-persisted-before.json /tmp/deploy-compose-persisted-after.json << 'DEPLOY_STORAGE_REWRITE_JS'
const fs = require("node:fs");

const [root, tmp, release, inputPath, outputPath] = process.argv.slice(2);
const data = JSON.parse(fs.readFileSync(inputPath, "utf8") || "{}");
const isObject = (value) => value && typeof value === "object" && !Array.isArray(value);
const tmpSuffix = (path) => path.slice(tmp.length);
const topSegment = (path) => tmpSuffix(path).replace(/^\\//, "").split("/")[0] || "";
const isExternalDataPath = (path) => /^(data|storage|uploads|upload|db|database)$/i.test(topSegment(path));
const isTmpPath = (path) => typeof path === "string" && (path === tmp || path.startsWith(tmp + "/"));
const rewriteCheckoutPath = (path, readOnly) => {
  if (!isTmpPath(path)) {
    return path;
  }

  if (isExternalDataPath(path)) {
    return root + tmpSuffix(path);
  }

  return readOnly ? release + tmpSuffix(path) : path;
};
const rewriteVolumeString = (volume) => {
  const parts = volume.split(":");
  if (parts.length <= 1 || !isTmpPath(parts[0])) {
    return volume;
  }

  const readOnly = parts.slice(2).includes("ro");
  return [rewriteCheckoutPath(parts[0], readOnly), ...parts.slice(1)].join(":");
};

if (isObject(data.services)) {
  for (const service of Object.values(data.services)) {
    if (!isObject(service)) {
      continue;
    }

    if (isObject(service.build) && typeof service.build.context === "string") {
      service.build.context = rewriteCheckoutPath(service.build.context, true);
    } else if (typeof service.build === "string") {
      service.build = rewriteCheckoutPath(service.build, true);
    }

    if (Array.isArray(service.volumes)) {
      service.volumes = service.volumes.map((volume) => {
        if (typeof volume === "string") {
          return rewriteVolumeString(volume);
        }

        if (isObject(volume) && typeof volume.source === "string") {
          return {
            ...volume,
            source: rewriteCheckoutPath(volume.source, Boolean(volume.read_only ?? volume.readonly ?? false))
          };
        }

        return volume;
      });
    }
  }
}

fs.writeFileSync(outputPath, JSON.stringify(data, null, 2) + "\\n");
DEPLOY_STORAGE_REWRITE_JS
                        docker compose -f /tmp/deploy-compose-persisted-after.json config --no-interpolate > ${targetFile}
                    else
                        cat /tmp/deploy-compose-persisted-rewrite-error.txt >&2
                        exit 1
                    fi
                fi`;
}

/**
 * Generates a Deploy-owned storage overlay that rewrites bind mounts expanded
 * against the temporary checkout back to the persistent project root.
 */
export function renderProjectRootStorageOverlayScript() {
    return `
                if [ -n "$COMPOSE_WORKSPACE" ] && [ -n "$TMP_DEPLOY" ]; then
                    mkdir -p "$COMPOSE_WORKSPACE"
                    PROJECT_ROOT_NO_SLASH="\${PROJECT_ROOT%/}"
                    TMP_DEPLOY_NO_SLASH="\${TMP_DEPLOY%/}"
                    if docker compose $COMPOSE_FILES config --format json > /tmp/deploy-compose-storage-source.json 2> /tmp/deploy-compose-storage-error.txt; then
                        node - "$PROJECT_ROOT_NO_SLASH" "$TMP_DEPLOY_NO_SLASH" /tmp/deploy-compose-storage-source.json "$COMPOSE_WORKSPACE/docker-compose.storage.yml" << 'DEPLOY_STORAGE_OVERLAY_JS'
const fs = require("node:fs");

const [root, tmp, inputPath, outputPath] = process.argv.slice(2);
const data = JSON.parse(fs.readFileSync(inputPath, "utf8") || "{}");
const isObject = (value) => value && typeof value === "object" && !Array.isArray(value);
const isTmpPath = (path) => typeof path === "string" && (path === tmp || path.startsWith(tmp + ":") || path.startsWith(tmp + "/"));
const rewritePath = (path) => root + path.slice(tmp.length);
const overlay = { services: {} };

if (isObject(data.services)) {
  for (const [serviceName, service] of Object.entries(data.services)) {
    const volumes = isObject(service) && Array.isArray(service.volumes) ? service.volumes : [];
    const rewritten = volumes.map((volume) => {
      if (typeof volume === "string" && isTmpPath(volume)) {
        return rewritePath(volume);
      }

      if (isObject(volume) && typeof volume.source === "string" && isTmpPath(volume.source)) {
        return { ...volume, source: rewritePath(volume.source) };
      }

      return volume;
    });

    if (JSON.stringify(rewritten) !== JSON.stringify(volumes)) {
      overlay.services[serviceName] = { volumes: rewritten };
    }
  }
}

if (Object.keys(overlay.services).length) {
  fs.writeFileSync(outputPath, JSON.stringify(overlay, null, 2) + "\\n");
} else {
  fs.writeFileSync(outputPath, "");
}
DEPLOY_STORAGE_OVERLAY_JS
                        if [ -s "$COMPOSE_WORKSPACE/docker-compose.storage.yml" ]; then
                            echo "--> Writing storage bind-mount override."
                            COMPOSE_FILES="$COMPOSE_FILES -f $COMPOSE_WORKSPACE/docker-compose.storage.yml"
                        else
                            rm -f "$COMPOSE_WORKSPACE/docker-compose.storage.yml"
                        fi
                    else
                        cat /tmp/deploy-compose-storage-error.txt >&2
                    fi
                fi`;
}

/**
 * Fails deployment before build/down/up when the persisted deployment Compose
 * file still points a bind mount at the temporary checkout.
 */
export function renderPersistedStorageGuardScript(targetFile: string) {
    return `
                if [ -f ${targetFile} ] && [ -n "$TMP_DEPLOY" ]; then
                    TMP_DEPLOY_NO_SLASH="\${TMP_DEPLOY%/}"
                    if docker compose -f ${targetFile} config --format json > /tmp/deploy-compose-persisted.json 2> /tmp/deploy-compose-persisted-error.txt; then
                        if node - "$TMP_DEPLOY_NO_SLASH" /tmp/deploy-compose-persisted.json << 'DEPLOY_STORAGE_GUARD_JS'
const fs = require("node:fs");

const [tmp, inputPath] = process.argv.slice(2);
const data = JSON.parse(fs.readFileSync(inputPath, "utf8") || "{}");
const isObject = (value) => value && typeof value === "object" && !Array.isArray(value);
const isTmpPath = (path) => typeof path === "string" && (path === tmp || path.startsWith(tmp + ":") || path.startsWith(tmp + "/"));
let found = false;

if (isObject(data.services)) {
  for (const service of Object.values(data.services)) {
    const volumes = isObject(service) && Array.isArray(service.volumes) ? service.volumes : [];
    for (const volume of volumes) {
      if (typeof volume === "string" && isTmpPath(volume)) {
        found = true;
      } else if (isObject(volume) && isTmpPath(volume.source)) {
        found = true;
      }
    }
  }
}

process.exit(found ? 0 : 1);
DEPLOY_STORAGE_GUARD_JS
                        then
                            echo "--> CRITICAL: Persistent Compose file still contains temporary checkout bind mounts." >&2
                            exit 1
                        fi
                    else
                        cat /tmp/deploy-compose-persisted-error.txt >&2
                        exit 1
                    fi
                fi`;
}

/**
 * Keeps the persisted deploy compose file independent from the temporary
 * checkout when Docker Compose expands env_file paths to absolute paths.
 */
export function renderPersistedEnvFileRewriteScript(targetFile: string) {
    return `
                if [ -f "$PROJECT_ROOT/.env" ]; then
                    sed -i "s|$PWD/.env|$PROJECT_ROOT/.env|g" ${targetFile}
                    sed -i "s|$TMP_DEPLOY/.env|$PROJECT_ROOT/.env|g" ${targetFile}
                fi`;
}

/**
 * Keeps generated or repository-declared Compose secret files independent
 * from the temporary checkout used during deployment.
 */
export function renderPersistedSecretFileRewriteScript(targetFile: string) {
    return `
                if [ -f ${targetFile} ] && [ -n "$TMP_DEPLOY" ] && [ -n "$COMPOSE_WORKSPACE" ]; then
                    TMP_DEPLOY_NO_SLASH="\${TMP_DEPLOY%/}"
                    COMPOSE_WORKSPACE_NO_SLASH="\${COMPOSE_WORKSPACE%/}"
                    # Rewrite the rendered YAML directly first. Docker Compose
                    # may emit either one or two slashes after the checkout
                    # path when resolving a relative secret file.
                    sed -i "s|$TMP_DEPLOY_NO_SLASH//secrets/|$COMPOSE_WORKSPACE_NO_SLASH/secrets/|g" ${targetFile}
                    sed -i "s|$TMP_DEPLOY_NO_SLASH/secrets/|$COMPOSE_WORKSPACE_NO_SLASH/secrets/|g" ${targetFile}
                    if docker compose -f ${targetFile} config --format json > /tmp/deploy-compose-secret-source.json 2> /tmp/deploy-compose-secret-rewrite-error.txt; then
                        node - "$TMP_DEPLOY_NO_SLASH" "$COMPOSE_WORKSPACE_NO_SLASH" /tmp/deploy-compose-secret-source.json /tmp/deploy-compose-secret-after.json << 'DEPLOY_SECRET_PATH_REWRITE_JS'
const fs = require("node:fs");

const [tmp, workspace, inputPath, outputPath] = process.argv.slice(2);
const data = JSON.parse(fs.readFileSync(inputPath, "utf8") || "{}");
const isObject = (value) => value && typeof value === "object" && !Array.isArray(value);
const isTmpPath = (value) => typeof value === "string" && (value === tmp || value.startsWith(tmp + "/"));
let changed = false;

if (isObject(data.secrets)) {
  for (const secret of Object.values(data.secrets)) {
    if (!isObject(secret) || typeof secret.file !== "string" || !isTmpPath(secret.file)) {
      continue;
    }

    const relative = secret.file.slice(tmp.length).replace(/^\\/+/, "");
    if (!relative.startsWith("secrets/")) {
      continue;
    }

    secret.file = workspace + "/" + relative;
    changed = true;
  }
}

fs.writeFileSync(outputPath, JSON.stringify(data, null, 2) + "\\n");
process.exit(changed ? 0 : 1);
DEPLOY_SECRET_PATH_REWRITE_JS
                        then
                            docker compose -f /tmp/deploy-compose-secret-after.json config --no-interpolate > ${targetFile}
                        fi
                    else
                        cat /tmp/deploy-compose-secret-rewrite-error.txt >&2
                    fi
                fi`;
}
