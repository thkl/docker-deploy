#!/bin/sh
# Navigate to where your main application code is mounted inside this container
cd /root/mwiz/mwiz

echo "Pulling latest changes..."
git pull

echo "Rebuilding container..."
docker compose up -d --build