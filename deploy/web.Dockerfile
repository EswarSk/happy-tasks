FROM node:22.22.2-alpine3.22 AS dependencies

WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci

FROM node:22.22.2-alpine3.22 AS build

WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
ARG NEXT_PUBLIC_API_BASE_URL=http://localhost:8080
ARG NEXT_PUBLIC_DATA_SOURCE=api
ENV NEXT_PUBLIC_API_BASE_URL=$NEXT_PUBLIC_API_BASE_URL
ENV NEXT_PUBLIC_DATA_SOURCE=$NEXT_PUBLIC_DATA_SOURCE

COPY --from=dependencies /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:22.22.2-alpine3.22 AS runtime

WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000

COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/.next ./.next
COPY --from=build --chown=node:node /app/public ./public

USER node
EXPOSE 3000
CMD ["npm", "run", "start"]
