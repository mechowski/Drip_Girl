# syntax=docker/dockerfile:1

FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm run build:server && npm prune --omit=dev

FROM node:24-bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends tzdata \
  && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    TZ=Europe/Moscow
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/server-dist ./server-dist
COPY server ./server
USER node
EXPOSE 3000
CMD ["node", "server/start.mjs"]
