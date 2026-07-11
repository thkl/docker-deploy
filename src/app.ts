import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import express, { Request, Response, NextFunction } from 'express';
import { exec } from "node:child_process";
import crypto from 'crypto';

interface AuthenticatedRequest extends Request {
    rawBody?: Buffer;
}

class App {

    app = express();
    port: number;

    constructor() {
        this.port = parseInt(process.env.PORT || "3999");
    }


    verifySignature(repoToken: string, req: Request, res: Response) {

        try {

            const authReq = req as AuthenticatedRequest;
            // 1. Grab the Standard Webhook Spec headers sent by GitLab
            const webhookId = req.headers['webhook-id'] as string;
            const webhookTimestamp = req.headers['webhook-timestamp'] as string;
            const webhookSignatureHeader = req.headers['webhook-signature'] as string;
            const secretKeyRaw = repoToken.replace(/^whsec_/, '');
            const secretBuffer = Buffer.from(secretKeyRaw, 'base64');
            const rawBodyString = authReq.rawBody ? authReq.rawBody.toString('utf8') : '';
            const messageToSign = `${webhookId}.${webhookTimestamp}.${rawBodyString}`;
            const computedHmac = crypto
                .createHmac('sha256', secretBuffer)
                .update(messageToSign)
                .digest('base64');

            const expectedSignature = `v1,${computedHmac}`;
            const signaturesReceived = webhookSignatureHeader.split(' ');
            let isSignatureValid = false;

            for (const sig of signaturesReceived) {
                if (sig.length === expectedSignature.length &&
                    crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expectedSignature))) {
                    isSignatureValid = true;
                    break;
                }
            }

            if (!isSignatureValid) {
                console.warn('Unauthorized: Invalid cryptographic signature.');
                res.status(403).send('Forbidden: Invalid webhook signature.');
                return false;
            }

            const currentTimestamp = Math.floor(Date.now() / 1000);
            const requestTimestamp = parseInt(webhookTimestamp, 10);
            if (Math.abs(currentTimestamp - requestTimestamp) > 300) {
                console.warn('Unauthorized: Webhook timestamp drifted too far (Replay Attack protection).');
                res.status(403).send('Forbidden: Expired signature timestamp.');
                return false;
            }

        } catch (err) {
            console.error('Signature calculation crash:', err);
            res.status(500).send('Internal validation error.');
            return false;
        }
        return true;
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

        this.app.use(express.json({
            verify: (req: Request, res: Response, buf: Buffer) => {
                if (buf && buf.length) {
                    (req as AuthenticatedRequest).rawBody = buf;
                }
            }
        }));

        this.app.use(express.urlencoded({
            extended: true,
            verify: (req: Request, res: Response, buf: Buffer) => {
                if (buf && buf.length) {
                    (req as AuthenticatedRequest).rawBody = buf;
                }
            }
        }));


        this.app.get('/health', (req: Request, res: Response) => {
            res.status(200).send('I am alive');
        });

        this.app.post('/webhook', (req: Request, res: Response) => {
            const event = req.headers['x-gitlab-event'];

            if (event === 'Push Hook') {
                const repoName = req.body.repository.name;
                const appSettings = this.fetchProfile(repoName);
                if (!appSettings) {
                    throw new Error("No config for this repository");
                }

                const repoToken = appSettings.token;
                const hostAppsPath = appSettings.path ?? `/root/docker-apps/${repoName}`;

                if (this.verifySignature(repoToken, req, res)) {

                    console.log(`Spinning up Ephemeral Build Worker for ${repoName}...`);

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
                            if (stderr) console.error(`Worker Inner Error (stderr):\n${stderr}`);
                            if (stdout) console.log(`Worker Partial Output (stdout):\n${stdout}`);
                            return;
                        }
                        console.log(`Worker output:\n${stdout}`);
                    });
                }

                res.status(200).send('Build worker dispatched');
            }
        });

        this.app.listen(this.port, () => console.log('Build-First Webhook Factory active.'));
    }
}

new App().init();