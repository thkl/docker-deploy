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

        console.log(`Spinning up Build-First Worker for ${repoName}...`);

        const workerCommands = [
            `cd /${repoName}`,
            `git pull`,


            // Use standard shell logic for the build test instead of relying on a fragile && chain
            `echo "Testing build for new changes..."`,
            `docker compose build`,
            `BUILD_STATUS=$?`, // Capture the exit code of the build command (0 = success)

            `if [ $BUILD_STATUS -eq 0 ]; then
        echo "Build succeeded! Swapping containers now..."
        docker rm -f ${repoName} || true
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