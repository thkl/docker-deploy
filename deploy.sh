#!/bin/sh

# Move to the mounted target app directory
cd /target-app

echo "Pulling latest changes from Git..."
git pull

echo "Rebuilding and recreating the application container..."
# --force-recreate ensures the old container name is released and replaced cleanly
docker compose up -d --build --force-recreate