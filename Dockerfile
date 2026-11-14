# Hub server: Node 20 built-ins; git + ssh only for the per-project sync button.
FROM node:20-slim
RUN apt-get update && apt-get install -y --no-install-recommends git openssh-client ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY public ./public
ENV NODE_ENV=production
CMD ["node", "src/main.js"]
