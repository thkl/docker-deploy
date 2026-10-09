#!/bin/sh

set -eu

PROJECT_ROOT=${UPDATER_PROJECT_ROOT:-/root/updater}
TMP_DEPLOY=${UPDATER_TMP_DEPLOY:-$PROJECT_ROOT/.updater/tmpdeploy}
SERVICE=${UPDATER_SERVICE:-deploy}
IMAGE=${UPDATER_IMAGE:-updater-deploy}

if [ ! -d "$PROJECT_ROOT" ]; then
    echo "CRITICAL: Updater project root does not exist: $PROJECT_ROOT" >&2
    exit 1
fi

if [ ! -d "$TMP_DEPLOY" ]; then
    echo "CRITICAL: Temporary deployment checkout does not exist: $TMP_DEPLOY" >&2
    echo "The updater must be deployed once normally, or the repository must be cloned there first." >&2
    exit 1
fi

if [ ! -f "$TMP_DEPLOY/Dockerfile" ]; then
    echo "CRITICAL: Dockerfile does not exist in the temporary checkout: $TMP_DEPLOY/Dockerfile" >&2
    exit 1
fi

COMPOSE_FILE=${UPDATER_COMPOSE_FILE:-}
if [ -z "$COMPOSE_FILE" ]; then
    for candidate in docker-compose.yaml docker-compose.yml compose.yaml compose.yml; do
        if [ -f "$TMP_DEPLOY/$candidate" ]; then
            COMPOSE_FILE="$TMP_DEPLOY/$candidate"
            break
        fi
    done
fi

if [ -z "$COMPOSE_FILE" ] || [ ! -f "$COMPOSE_FILE" ]; then
    echo "CRITICAL: No Compose file found in $TMP_DEPLOY." >&2
    exit 1
fi

if [ -d "$TMP_DEPLOY/.git" ] && [ "${UPDATER_SKIP_PULL:-false}" != "true" ]; then
    echo "--> Updating recovery checkout..."
    git -C "$TMP_DEPLOY" pull --ff-only
fi

echo "--> Building updater image from $TMP_DEPLOY..."
docker build --target runtime -t "$IMAGE" "$TMP_DEPLOY"

echo "--> Recreating updater service from $COMPOSE_FILE..."
docker compose \
    --project-directory "$PROJECT_ROOT" \
    -f "$COMPOSE_FILE" \
    up -d --no-build --force-recreate "$SERVICE"

echo "--> Emergency updater recovery completed."
