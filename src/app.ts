import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import express, { type Express, type Request, type Response } from 'express';
import { exec } from "node:child_process";

class App {

    app: Express = express();
    port: number;

    constructor() {
       this.port = parseInt(process.env.PORT || "3999");
    }

    fetchProfile(app: string) {
        try {
            const settingPath = join("./data", "config.json");
            if (existsSync(settingPath)) {
                const settings = JSON.parse(readFileSync(settingPath).toString());
                if (settings) {
                    return settings[app];
                }
            }
        } catch (e) {
            console.log("Error reading config")
        }
    }

    init() {

        this.app.use(express.json());

        this.app.get('/health', (req: Request, res: Response) => {
            res.status(200).send('I am alive');
        });

        this.app.post('/webhook', (req: Request, res: Response) => {
            const event = req.headers['x-gitlab-event'];
            const token = req.headers['X-Gitlab-Token'];

            if (event === 'Push Hook') {
                const repoName = req.body.repository.name;
                const appSettings = this.fetchProfile(repoName);
                if (!appSettings) {
                    throw new Error("No config for this repository");
                }

                const hostAppsPath = appSettings.path ?? `/root/docker-apps/${repoName}`;
                const repoToken = appSettings.token;
                if (repoToken && token !== repoToken) {
                    throw new Error("Security Token does not match");
                }

                console.log(`Spinning up Ephemeral Build Worker for ${repoName}...`);

                // Added back --rm so the container automatically destroys itself when done
                const dockerRunCommand = `docker run -i --rm \
            -v /var/run/docker.sock:/var/run/docker.sock \
            -v ${hostAppsPath}:${hostAppsPath} \
            -v ~/.ssh:/root/.ssh:ro \
            alpine:latest sh << 'EOF'
                apk add --no-cache docker-cli docker-cli-compose docker-cli-buildx git openssh-client > /dev/null 2>&1

                cd ${hostAppsPath}
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

        this.app.listen(this.port, () => console.log('Build-First Webhook Factory active.'));
    }

}

new App().init();