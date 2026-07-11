FROM node:20-alpine

# Install Docker CLI, Docker Compose, and Git
RUN apk add --no-cache docker-cli docker-cli-compose git openssh-client

WORKDIR /app

# Copy package files and install Express
COPY package*.json ./
RUN npm install

# Copy application files
COPY app.js deploy.sh ./
RUN chmod +x deploy.sh

EXPOSE 3999

CMD ["node", "app.js"]