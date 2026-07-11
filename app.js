const express = require('express');
const { exec } = require('child_process');
const app = express();
const PORT = 3999;

app.use(express.json());

app.post('/webhook', (req, res) => {
    // Optional: Validate GitLab Webhook Token
    // if (req.headers['x-gitlab-token'] !== 'YOUR_SECRET_TOKEN') {
    //     return res.status(401).send('Unauthorized');
    // }

    const event = req.headers['x-gitlab-event'];
    console.log(`Received event: ${event}`);

    if (event === 'Push Hook') {
        console.log('Push detected! Running deploy script...');
        
        // Execute the update script
        exec('/app/deploy.sh', (error, stdout, stderr) => {
            if (error) {
                console.error(`Error: ${error.message}`);
                return;
            }
            console.log(`stdout: ${stdout}`);
            if (stderr) console.error(`stderr: ${stderr}`);
        });
    }

    res.status(200).send('Trigger received');
});

app.listen(PORT, () => console.log(`Webhook listener running on port ${PORT}`));