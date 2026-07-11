const express = require('express');
const { exec } = require('child_process');
const app = express();
const PORT = 3999;

app.use(express.json());

app.post('/webhook', (req, res) => {
    const event = req.headers['x-gitlab-event'];
    
    if (event === 'Push Hook') {
        const repoName = req.body.repository.name; // e.g., "sonos-autoplay"
        const hostAppsPath = `/root/docker-apps/${repoName}`;
        
        console.log(`Spinning up Build-First Worker for ${repoName}...`);

        const workerCommands = [
            `cd /${repoName}`,
            `git pull`,
            
            // 1. Only BUILD the images. Do not create or start any containers yet.
            `echo "Testing build for new changes..."`,
            `if docker compose build; then
                echo "Build succeeded! Swapping containers now..."
                
                # 2. Stop and remove the old running container
                docker rm -f ${repoName} || true
                
                # 3. Create and start the container using the freshly built image
                # --no-build ensures it uses what we just compiled
                docker compose up -d --no-build
                
                echo "Deployment successful."
             else
                echo "CRITICAL: Build failed! Keeping the old container running."
                exit 1
             fi`
        ].join(' && ');

        const dockerRunCommand = `docker run --rm \
            -v /var/run/docker.sock:/var/run/docker.sock \
            -v ${hostAppsPath}:/${repoName} \
            -v ~/.ssh:/root/.ssh:ro \
            alpine:latest \
            sh -c "apk add --no-cache docker-cli docker-cli-compose docker-cli-buildx git openssh-client && ${workerCommands}"`;

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