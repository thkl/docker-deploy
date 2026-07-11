FROM node:24.16.0-slim AS builder

WORKDIR /app

# Added docker-cli-buildx to the list
RUN apk add --no-cache docker-cli docker-cli-compose docker-cli-buildx git openssh-client \
  && corepack enable \
  && corepack prepare pnpm@10.32.0 --activate

COPY package.json tsconfig.json ./
COPY src ./src

RUN pnpm install
RUN pnpm run build

VOLUME ["/app/data"]


COPY package.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist

EXPOSE 3999

CMD ["node", "dist/app.js"]
