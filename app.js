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
        console.log(`Spinning up DEBUG Worker: ${debugContainerName}`);

        // 1. Forcefully remove any leftover debug container from a previous run
        exec(`docker rm -f ${debugContainerName}`, () => {
            
            // 2. Spawn the worker WITHOUT --rm so it stays behind if it dies
            const dockerRunCommand = `docker run -i -rm \
                --name ${debugContainerName} \
                -v /var/run/docker.sock:/var/run/docker.sock \
                -v ${hostAppsPath}:/${repoName} \
                -v ~/.ssh:/root/.ssh:ro \
                alpine:latest sh << 'EOF'
                    apk add --no-cache docker-cli docker-cli-compose docker-cli-buildx git openssh-client
                    cd /${repoName}
                    echo "--> Fetching latest changes..."
                    git pull
                    echo "--> Testing build..."
                    docker compose build
                    if [ $? -eq 0 ]; then
                        echo "--> Build succeeded!"
                        docker rm -f ${repoName} || true
                        docker compose up -d --no-build
                    else
                        echo "--> Build failed!"
                        exit 1
                    fi
EOF`;

            exec(dockerRunCommand, (error, stdout, stderr) => {
                console.log(`Execution finished. System Error Obj:`, error);
                console.log(`stdout:\n${stdout}`);
                console.log(`stderr:\n${stderr}`);
                
                console.log(`\n👉 DEBUG INSTRUCTION: Run 'docker logs ${debugContainerName}' on your Proxmox host right now to see what failed inside!`);
            });
        });
    }

    res.status(200).send('Build worker dispatched');
});

app.listen(PORT, () => console.log('Build-First Webhook Factory active.'));