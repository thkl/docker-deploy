FROM node:24.16.0-alpine 
# Note: Added '-alpine' because 'apk' requires an Alpine-based image

WORKDIR /app

# 1. Install system dependencies
RUN apk add --no-cache docker-cli docker-cli-compose docker-cli-buildx git openssh-client
RUN corepack enable && corepack prepare pnpm@10.32.0 --activate

# 2. Copy dependency files and install
COPY package.json pnpm-lock.yaml* tsconfig.json ./
RUN pnpm install

# 3. Copy source code and build
COPY src ./src
RUN pnpm run build

# 4. Define volume and runtime settings
VOLUME ["/app/data"]
EXPOSE 3999

CMD ["node", "dist/app.js"]