#!/bin/sh

# 1. Move to the mounted target app directory
cd /sonos-autoplay

# 2. Pull the latest code from GitLab
echo "Pulling latest changes from Git..."
git pull

# 3. Forcefully remove the old container by its exact name to free up the port/name lock
echo "Forcefully removing old container to prevent conflicts..."
docker rm -f sonos-autoplay || true

# 4. Run the fresh build and bring it up
echo "Rebuilding and starting the application..."
docker compose up -d --build