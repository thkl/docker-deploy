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

        // Use a clean multiline template literal for the shell script inside the worker
        const workerScript = `
            cd /${repoName}
            echo "Fetching latest changes..."
            git pull
            
            echo "Testing build for new changes..."
            docker compose build
            BUILD_STATUS=$?
            
            if [ $BUILD_STATUS -eq 0 ]; then
                echo "Build succeeded! Swapping containers now..."
                docker rm -f ${repoName} || true
                docker compose up -d --no-build
                echo "Deployment successful."
            else
                echo "CRITICAL: Build failed! Keeping the old container running."
                exit 1
            fi
        `;

        // Pass the script into sh -c via a single, clean execution block
        const dockerRunCommand = `docker run --rm \
            -v /var/run/docker.sock:/var/run/docker.sock \
            -v ${hostAppsPath}:/${repoName} \
            -v ~/.ssh:/root/.ssh:ro \
            alpine:latest \
            sh -c "${workerScript.replace(/\n/g, ' ')}"`;

        exec(dockerRunCommand, (error, stdout, stderr) => {
            if (error) {
                console.error(`Deployment Aborted: ${error.message}`);
                if (stderr) console.error(`stderr: ${stderr}`);
                return;
            }
            console.log(`Worker output:\n${stdout}`);
        });
    }

    res.status(200).send('Build worker dispatched');
});

app.listen(PORT, () => console.log('Build-First Webhook Factory active.'));