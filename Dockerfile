# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim AS build

WORKDIR /app

COPY package.json package-lock.json ./
# No dependency runs install scripts. node-pty loads its prebuilt linux-x64 and linux-arm64
# binaries without them, and the root postinstall only fixes macOS binaries.
RUN npm ci --ignore-scripts

COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build
# What the npm package holds, as `files` in package.json: no build cache, no dev dependencies.
RUN rm -rf .next/cache && find .next -name '*.js.map' -delete && npm prune --omit=dev

# Bake the first-party pi plugins into the image: declarations go into the baked
# settings.json and the packages install into the managed npm dir, so the first
# container start is a fingerprint no-op (PI_CODING_AGENT_DIR keeps it out of
# root's home; the runtime stage copies it to the node user's home).
RUN PI_CODING_AGENT_DIR=/home/node/.pi node bin/pi-plugins-provision.js

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production \
    HOME=/home/node \
    PORT=30141 \
    PI_WEB_HOSTNAME=0.0.0.0 \
    PI_WEB_NO_OPEN=1

# git is used by project tools; bash is needed by the agent's shell tool and terminal.
RUN apt-get update \
    && apt-get install -y --no-install-recommends bash ca-certificates git \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /home/node/.pi/agent /home/node/.agents/skills /home/node/pi-cwd \
    && chown -R node:node /home/node/.pi /home/node/.agents /home/node/pi-cwd

WORKDIR /app
COPY --from=build --chown=node:node /app/bin ./bin
COPY --from=build --chown=node:node /app/.next ./.next
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/public ./public
COPY --from=build --chown=node:node /app/next.config.ts /app/package.json ./
COPY --from=build --chown=node:node /app/pi-plugins.manifest.json ./pi-plugins.manifest.json
COPY --from=build --chown=node:node /home/node/.pi /home/node/.pi
USER node

EXPOSE 30141
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.PORT}`).then(r => process.exit(r.status < 500 ? 0 : 1)).catch(() => process.exit(1))"]

CMD ["node", "bin/pi-web.js"]
