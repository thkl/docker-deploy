FROM node:24.16.0-alpine 
# Note: Added '-alpine' because 'apk' requires an Alpine-based image

WORKDIR /app

# 1. Install system dependencies
RUN apk add --no-cache docker-cli docker-cli-compose docker-cli-buildx git openssh-client
RUN corepack enable && corepack prepare pnpm@11.6.0 --activate

# 2. Copy backend dependency files and install
COPY package.json pnpm-lock.yaml* tsconfig.json ./
RUN pnpm install --allow-build

# 3. Copy frontend dependency files and install
COPY frontend/package.json frontend/pnpm-lock.yaml* frontend/angular.json frontend/tsconfig*.json ./frontend/
RUN cd frontend && pnpm install --allow-build

# 4. Copy source code and build
COPY src ./src
COPY frontend/src ./frontend/src
COPY frontend/public ./frontend/public
RUN pnpm run build
RUN pnpm --dir frontend build

# 5. Define volume and runtime settings
VOLUME ["/app/data"]
EXPOSE 3999

CMD ["node", "dist/app.js"]
