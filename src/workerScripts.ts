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
