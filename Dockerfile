FROM node:22-trixie-slim AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
RUN npm ci

FROM node:22-trixie-slim AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:22-trixie-slim AS production-deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
RUN npm ci --omit=dev

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
RUN apt-get update \
  && apt-get install -y --no-install-recommends fontconfig fonts-dejavu-core gosu python3 \
  && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/package.json ./package.json
COPY --from=production-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY docker-entrypoint.sh /entrypoint.sh
COPY docker-ownership-repair.py /ownership-repair.py
RUN chmod 755 /entrypoint.sh
RUN mkdir -p /config && chown node:node /config
ENTRYPOINT ["/entrypoint.sh"]
EXPOSE 9301
CMD ["node", "dist/server/server/index.js"]
