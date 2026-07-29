FROM node:24.16.0-alpine AS base

WORKDIR /app

RUN apk add --no-cache docker-cli docker-cli-compose docker-cli-buildx git openssh-client
RUN corepack enable

COPY package.json pnpm-lock.yaml* tsconfig.json ./
RUN npm install

COPY src ./src
RUN npm run build

FROM base AS frontend-build

COPY frontend/package.json frontend/pnpm-lock.yaml* frontend/angular.json frontend/tsconfig*.json ./frontend/
RUN cd frontend && npm install

COPY frontend/src ./frontend/src
COPY frontend/public ./frontend/public
RUN cd frontend && npm run build

FROM base AS agent

VOLUME ["/app/data"]
EXPOSE 3998

CMD ["node", "dist/app.js"]

FROM base AS runtime

COPY --from=frontend-build /app/frontend/dist ./frontend/dist

VOLUME ["/app/data"]
EXPOSE 3999 3998

CMD ["node", "dist/app.js"]
