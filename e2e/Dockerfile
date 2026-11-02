# Playwright runner. Browser image and npm package are both pinned to 1.56.1.
FROM mcr.microsoft.com/playwright:v1.56.1-noble
WORKDIR /e2e
COPY package.json package-lock.json* ./
RUN npm install --no-audit --no-fund
COPY . .
CMD ["npx", "playwright", "test"]
