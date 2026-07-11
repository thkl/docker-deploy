FROM node:20-alpine

# Added docker-cli-buildx to the list
RUN apk add --no-cache docker-cli docker-cli-compose docker-cli-buildx git openssh-client

WORKDIR /app

COPY package*.json ./
RUN pnpm install
RUN pnpm run build

COPY package.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist

VOLUME ["/app/data"]

EXPOSE 3999
CMD ["node", "dist/app.js"]
