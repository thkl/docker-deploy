#!/bin/sh

# Move to the mounted target app directory
cd /target-app

echo "Pulling latest changes from Git..."
git pull

export COMPOSE_PROJECT_NAME="sonos-autoplay"

echo "Stopping existing project containers..."
docker compose down

echo "Rebuilding and starting the application..."
docker compose up -d --build