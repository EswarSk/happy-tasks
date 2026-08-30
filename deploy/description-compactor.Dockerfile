FROM node:22-alpine

WORKDIR /app
COPY workers/description-compactor/package*.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev
COPY workers/description-compactor/*.mjs ./

USER node
CMD ["node", "index.mjs"]
