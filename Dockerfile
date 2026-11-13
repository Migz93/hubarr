# Base image pinned by digest so a rebuild can't silently pull a different
# toolchain under the same tag. Bump deliberately: resolve the new digest with
# `docker buildx imagetools inspect node:22-trixie-slim` and replace all four.
FROM node:22-trixie-slim@sha256:be1e2a3dc2c4fd68cdfadad2a696a280e0d2749098bee509230174d72fb768c6 AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
RUN npm ci

FROM node:22-trixie-slim@sha256:be1e2a3dc2c4fd68cdfadad2a696a280e0d2749098bee509230174d72fb768c6 AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:22-trixie-slim@sha256:be1e2a3dc2c4fd68cdfadad2a696a280e0d2749098bee509230174d72fb768c6 AS production-deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
RUN npm ci --omit=dev

FROM node:22-trixie-slim@sha256:be1e2a3dc2c4fd68cdfadad2a696a280e0d2749098bee509230174d72fb768c6 AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=9301
ENV DATA_DIR=/config
# Build metadata — overridden by CI workflows via --build-arg
ARG BUILD_CHANNEL=custom
ARG COMMIT_SHA=local
ENV BUILD_CHANNEL=$BUILD_CHANNEL
ENV COMMIT_SHA=$COMMIT_SHA
# Require Debian's zlib fix for CVE-2026-85091 and CVE-2026-76844.
RUN apt-get update \
  && apt-get install -y --no-install-recommends fontconfig fonts-dejavu-core gosu python3 zlib1g \
  && dpkg --compare-versions "$(dpkg-query -W -f='${Version}' zlib1g)" ge "1:1.3.dfsg+really1.3.1-1+deb13u1" \
  && rm -rf /var/lib/apt/lists/*
# The production image starts Node directly. Remove build-time package managers
# to reduce the runtime attack surface; the Yarn directory includes its version.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /opt/yarn-v* \
  && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg
COPY --from=build /app/package.json ./package.json
COPY --from=production-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY docker-entrypoint.sh /entrypoint.sh
COPY docker-ownership-repair.py /ownership-repair.py
RUN chmod 755 /entrypoint.sh
RUN mkdir -p /config && chown node:node /config
ENTRYPOINT ["/entrypoint.sh"]
EXPOSE 9301
# Uses Node's built-in fetch so the check needs no curl/wget and survives npm's
# removal above. Follows a custom PORT; /api/health is unauthenticated.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||9301)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/server/server/index.js"]
