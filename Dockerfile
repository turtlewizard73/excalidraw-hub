# Hub server: Node 20 built-ins only, nothing to install.
FROM node:20-slim
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY public ./public
ENV NODE_ENV=production
CMD ["node", "src/main.js"]
