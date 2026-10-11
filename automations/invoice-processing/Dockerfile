# syntax=docker/dockerfile:1

# The image of Invoice Processing, built from the repository root:
#   docker build --file automations/invoice-processing/Dockerfile .
#
# The SDK, the kit and the automation are workspaces during development, so the build
# uses the root lock. The runtime install below is deliberately different: it consumes
# the automation's own lockfile and packs the already-built local SDK and kit into
# node_modules, so the image carries its own copy of each and shares nothing at run
# time with another automation (ADR-0034 §6).
#
# Only this automation's, the SDK's and the kit's package.json are copied before
# `npm ci`: npm installs a root lock whose other workspaces are absent from disk, so
# one automation's image never sees another's files.
FROM node:22-alpine AS build
WORKDIR /workspace

COPY package.json package-lock.json tsconfig.base.json tsconfig.json ./
COPY packages/automation-sdk/package.json packages/automation-sdk/tsconfig.json ./packages/automation-sdk/
COPY packages/automation-kit/package.json packages/automation-kit/tsconfig.json ./packages/automation-kit/
COPY automations/invoice-processing/package.json automations/invoice-processing/tsconfig.json ./automations/invoice-processing/
RUN npm ci --ignore-scripts

COPY packages/automation-sdk/src ./packages/automation-sdk/src
COPY packages/automation-kit/src ./packages/automation-kit/src
COPY automations/invoice-processing/src ./automations/invoice-processing/src
RUN npm run build --workspace @autom8x/automation-sdk \
  && npm run build --workspace @autom8x/automation-kit \
  && npm run build --workspace @autom8x/invoice-processing

FROM node:22-alpine AS production-dependencies
WORKDIR /workspace

# `--install-links` packs the local SDK and kit instead of leaving symlinks to a build
# tree the runtime image does not contain. Each package exports only built `dist`.
COPY --from=build /workspace/packages/automation-sdk/package.json ./packages/automation-sdk/package.json
COPY --from=build /workspace/packages/automation-sdk/dist ./packages/automation-sdk/dist
COPY --from=build /workspace/packages/automation-kit/package.json ./packages/automation-kit/package.json
COPY --from=build /workspace/packages/automation-kit/dist ./packages/automation-kit/dist
COPY automations/invoice-processing/package.json automations/invoice-processing/package-lock.json ./automations/invoice-processing/
WORKDIR /workspace/automations/invoice-processing
RUN npm ci --omit=dev --ignore-scripts --workspaces=false --install-links=true

FROM node:22-alpine AS runtime
RUN apk upgrade --no-cache && apk add --no-cache tini
ENV NODE_ENV=production
WORKDIR /app

# The entrypoint is Node itself; npm and its dependency tree are not runtime code.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

COPY --chown=node:node automations/invoice-processing/package.json ./
COPY --chown=node:node --from=build /workspace/automations/invoice-processing/dist ./dist
COPY --chown=node:node --from=production-dependencies /workspace/automations/invoice-processing/node_modules ./node_modules
# The prompts the steps send, loaded from beside dist/ (none yet: the AI step's group adds it).
COPY --chown=node:node automations/invoice-processing/prompts ./prompts
# The manifest versions this container serves: the runner runs the pipeline each
# one declares and refuses a run pinned to any other (src/main.ts reads this dir).
COPY --chown=node:node manifests/invoice-processing.v*.json ./manifests/

LABEL org.opencontainers.image.source="https://github.com/siddak1234/snoopy-automations"

USER node
EXPOSE 8080
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/main.js"]
