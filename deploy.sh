#!/bin/sh

# Move to the mounted target app directory
cd /target-app

echo "Pulling latest changes from Git..."
git pull

echo "Stopping existing project containers to clear name locks..."
docker compose -p sonos-autoplay down

echo "Rebuilding and starting the application..."
docker compose -p sonos-autoplay up -d --build