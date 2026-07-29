FROM node:24.16.0-alpine 
# Note: Added '-alpine' because 'apk' requires an Alpine-based image

WORKDIR /app

# 1. Install system dependencies
RUN apk add --no-cache docker-cli docker-cli-compose docker-cli-buildx git openssh-client
RUN corepack enable

# 2. Copy backend dependency files and install
COPY package.json pnpm-lock.yaml* tsconfig.json ./
RUN npm install

# 3. Copy frontend dependency files and install
COPY frontend/package.json frontend/pnpm-lock.yaml* frontend/angular.json frontend/tsconfig*.json ./frontend/
RUN cd frontend && npm install 

# 4. Copy source code and build
COPY src ./src
COPY frontend/src ./frontend/src
COPY frontend/public ./frontend/public
RUN npm run build
RUN cd frontend && npm run build

# 5. Define volume and runtime settings
VOLUME ["/app/data"]
EXPOSE 3999 3998

CMD ["node", "dist/app.js"]
