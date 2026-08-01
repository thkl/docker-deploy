/**
 * Makes a project-root .env available to Docker Compose commands executed from
 * a Deploy-managed temporary checkout.
 */
export function renderProjectRootEnvFileScript() {
    return `
                if [ -f "$PROJECT_ROOT/.env" ] && [ ! -e .env ]; then
                    echo "--> Using project-root .env for Compose."
                    ln -s "$PROJECT_ROOT/.env" .env
                fi`;
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
                        jq --arg root "$PROJECT_ROOT_NO_SLASH" --arg tmp "$TMP_DEPLOY_NO_SLASH" --arg release "$RELEASE_DEPLOY_NO_SLASH" '
                            def tmp_suffix($path): $path[($tmp | length):];
                            def top_segment($path):
                                (tmp_suffix($path) | sub("^/"; "") | split("/") | .[0] // "");
                            def external_data_path($path):
                                (top_segment($path) | test("^(data|storage|uploads|upload|db|database)$"; "i"));
                            def rewrite_checkout_path($path; $read_only):
                                if ($path == $tmp or ($path | startswith($tmp + "/"))) then
                                    if external_data_path($path) then
                                        $root + tmp_suffix($path)
                                    elif $read_only then
                                        $release + tmp_suffix($path)
                                    else
                                        $path
                                    end
                                else
                                    $path
                                end;
                            def rewrite_volume_string($volume):
                                ($volume | split(":")) as $parts |
                                if (($parts | length) > 1) and (($parts[0] == $tmp) or ($parts[0] | startswith($tmp + "/"))) then
                                    ([rewrite_checkout_path($parts[0]; ($parts[2:] | index("ro") != null))] + $parts[1:]) | join(":")
                                else
                                    $volume
                                end;
                            .services = ((.services // {}) | with_entries(
                                .value |= (
                                    if (.build | type) == "object" and (.build.context | type) == "string" then
                                        .build.context = rewrite_checkout_path(.build.context; true)
                                    elif (.build | type) == "string" then
                                        .build = rewrite_checkout_path(.build; true)
                                    else
                                        .
                                    end
                                    | if (.volumes | type) == "array" then
                                        .volumes |= map(
                                            if type == "string" then
                                                rewrite_volume_string(.)
                                            elif type == "object" and (.source | type) == "string" then
                                                .source = rewrite_checkout_path(.source; ((.read_only // .readonly // false) == true))
                                            else
                                                .
                                            end
                                        )
                                    else
                                        .
                                    end
                                )
                            ))
                        ' /tmp/deploy-compose-persisted-before.json > /tmp/deploy-compose-persisted-after.json
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
                        jq --arg root "$PROJECT_ROOT_NO_SLASH" --arg tmp "$TMP_DEPLOY_NO_SLASH" '
                            (.services // {}) | to_entries | map(
                                . as $service |
                                ($service.value.volumes // []) as $volumes |
                                ($volumes | map(
                                    if type == "string" and (. == $tmp or startswith($tmp + ":") or startswith($tmp + "/"))
                                    then ($root + (.[($tmp | length):]))
                                    elif type == "object"
                                         and (.source | type) == "string"
                                         and (.source == $tmp or (.source | startswith($tmp + "/")))
                                    then .source = ($root + (.source[($tmp | length):]))
                                    else .
                                    end
                                )) as $rewritten |
                                select($rewritten != $volumes) |
                                { key: $service.key, value: { volumes: $rewritten } }
                            ) | from_entries | select(length > 0) | { services: . }
                        ' /tmp/deploy-compose-storage-source.json > "$COMPOSE_WORKSPACE/docker-compose.storage.yml"
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
                        if jq -e --arg tmp "$TMP_DEPLOY_NO_SLASH" '
                            [
                                (.services // {})[]?.volumes[]? |
                                if type == "string" then
                                    (. == $tmp or startswith($tmp + ":") or startswith($tmp + "/"))
                                elif type == "object" and (.source | type) == "string" then
                                    (.source == $tmp or (.source | startswith($tmp + "/")))
                                else
                                    false
                                end
                            ] | any
                        ' /tmp/deploy-compose-persisted.json > /dev/null; then
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
