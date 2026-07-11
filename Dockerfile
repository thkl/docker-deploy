FROM node:20-alpine

# Added docker-cli-buildx to the list
RUN apk add --no-cache docker-cli docker-cli-compose docker-cli-buildx git openssh-client

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY app.js ./

EXPOSE 3999

CMD ["node", "app.js"]