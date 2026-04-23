FROM node:22-trixie-slim AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install

FROM node:22-trixie-slim AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:22-trixie-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=9301
ENV DATA_DIR=/config
# Build metadata — overridden by CI workflows via --build-arg
ARG BUILD_CHANNEL=custom
ARG COMMIT_SHA=local
ENV BUILD_CHANNEL=$BUILD_CHANNEL
ENV COMMIT_SHA=$COMMIT_SHA
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
RUN mkdir -p /config && chown -R node:node /config /app
USER node
EXPOSE 9301
CMD ["node", "dist/server/server/index.js"]

