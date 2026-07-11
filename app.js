const express = require('express');
const { exec } = require('child_process');
const app = express();
const PORT = 3999;

app.use(express.json());

app.post('/webhook', (req, res) => {
    const event = req.headers['x-gitlab-event'];

    if (event === 'Push Hook') {
        const repoName = req.body.repository.name; // e.g., "sonos-autoplay"
        const hostAppsPath = req.body.repository.path ?? `/root/docker-apps/${repoName}`;

// Give the debug container a fixed, predictable name
        const debugContainerName = `debug-worker-${repoName}`;
       console.log(`Spinning up Ephemeral Build Worker for ${repoName}...`);

        // Added back --rm so the container automatically destroys itself when done
        const dockerRunCommand = `docker run -i --rm \
            -v /var/run/docker.sock:/var/run/docker.sock \
            -v ${hostAppsPath}:/${repoName} \
            -v ~/.ssh:/root/.ssh:ro \
            alpine:latest sh << 'EOF'
                apk add --no-cache docker-cli docker-cli-compose docker-cli-buildx git openssh-client > /dev/null 2>&1

                cd /${repoName}
                echo "--> Fetching latest changes..."
                git pull
                
                echo "--> Testing build for new changes..."
                docker compose build
                if [ $? -eq 0 ]; then
                    echo "--> Build succeeded! Safely dropping old container via compose..."
                    docker compose down
                    
                    echo "--> Starting newly built container..."
                    docker compose up -d --no-build
                    echo "--> Deployment successful."
                else
                    echo "--> CRITICAL: Build failed! Keeping the old container running."
                    exit 1
                fi
            EOF`;

        exec(dockerRunCommand, (error, stdout, stderr) => {
            if (error) {
                console.error(`Deployment Aborted: ${error.message}`);
                return;
            }
            console.log(`Worker output:\n${stdout}`);
        });
    }

    res.status(200).send('Build worker dispatched');
});

app.listen(PORT, () => console.log('Build-First Webhook Factory active.'));