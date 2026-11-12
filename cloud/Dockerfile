FROM node:22-slim

ENV NODE_ENV=production
ENV PORT=8080
WORKDIR /app

COPY v2/core.js ./v2/core.js
COPY v2/view-model.js ./v2/view-model.js
COPY cloud/package*.json ./cloud/
WORKDIR /app/cloud
RUN npm ci --omit=dev --no-audit --no-fund

COPY cloud/src ./src
COPY cloud/public ./public
EXPOSE 8080
CMD ["node", "src/server.js"]
