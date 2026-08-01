/**
 * Makes a project-root .env available to Docker Compose commands executed from
 * an updater-managed temporary checkout.
 */
export function renderProjectRootEnvFileScript() {
    return `
                if [ -f "$PROJECT_ROOT/.env" ] && [ ! -e .env ]; then
                    echo "--> Using project-root .env for Compose."
                    ln -s "$PROJECT_ROOT/.env" .env
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
