# syntax=docker/dockerfile:1

# The image of one automation, built from the repository root:
#   docker build --file automations/example/Dockerfile .
# Replace `example` with your templateId everywhere in this file.
#
# The SDK and automation are workspaces during development, so the build uses the
# root lock. The runtime install below is deliberately different: it consumes the
# automation's own lockfile and packs the already-built local SDK into node_modules.
#
# Only this automation's and the SDK's package.json are copied before `npm ci`: npm
# installs a root lock whose other workspaces are absent from disk, so one
# automation's image never sees another's files (ADR-0034 §6).
FROM node:22-alpine AS build
WORKDIR /workspace

COPY package.json package-lock.json tsconfig.base.json tsconfig.json ./
COPY packages/automation-sdk/package.json packages/automation-sdk/tsconfig.json ./packages/automation-sdk/
COPY automations/example/package.json automations/example/tsconfig.json ./automations/example/
RUN npm ci --ignore-scripts

COPY packages/automation-sdk/src ./packages/automation-sdk/src
COPY automations/example/src ./automations/example/src
RUN npm run build --workspace @autom8x/automation-sdk \
  && npm run build --workspace @autom8x/example

FROM node:22-alpine AS production-dependencies
WORKDIR /workspace

# `--install-links` packs the local SDK instead of leaving a symlink to a build
# tree the runtime image does not contain. Its package exports only built `dist`.
COPY --from=build /workspace/packages/automation-sdk/package.json ./packages/automation-sdk/package.json
COPY --from=build /workspace/packages/automation-sdk/dist ./packages/automation-sdk/dist
COPY automations/example/package.json automations/example/package-lock.json ./automations/example/
WORKDIR /workspace/automations/example
RUN npm ci --omit=dev --ignore-scripts --workspaces=false --install-links=true

FROM node:22-alpine AS runtime
RUN apk upgrade --no-cache && apk add --no-cache tini
ENV NODE_ENV=production
WORKDIR /app

# The entrypoint is Node itself; npm and its dependency tree are not runtime code.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

COPY --chown=node:node automations/example/package.json ./
COPY --chown=node:node --from=build /workspace/automations/example/dist ./dist
COPY --chown=node:node --from=production-dependencies /workspace/automations/example/node_modules ./node_modules
# The prompts the steps send, loaded by src/automation.ts from beside dist/.
COPY --chown=node:node automations/example/prompts ./prompts
# The manifest versions this container serves: the runner runs the pipeline each
# one declares and refuses a run pinned to any other (src/main.ts reads this dir).
COPY --chown=node:node manifests/example.v*.json ./manifests/

LABEL org.opencontainers.image.source="https://github.com/siddak1234/snoopy-automations"

USER node
EXPOSE 8080
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/main.js"]
