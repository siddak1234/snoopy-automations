# syntax=docker/dockerfile:1

# The image of Invoice Processing v7, built from the repository root:
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
#
# The one FROM that names an image, `base`: the same Node by tag and index digest in every flow,
# and every stage builds FROM it, since Dependabot moves only a Dockerfile's first FROM (README,
# "Working here", pinned base images).
FROM node:22.23.4-alpine@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914 AS base

FROM base AS build
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

FROM base AS production-dependencies
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

FROM base AS runtime
RUN apk upgrade --no-cache && apk add --no-cache tini
ENV NODE_ENV=production
WORKDIR /app

# The entrypoint is Node itself; npm and its dependency tree are not runtime code.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

COPY --chown=node:node automations/invoice-processing/package.json ./
COPY --chown=node:node --from=build /workspace/automations/invoice-processing/dist ./dist
COPY --chown=node:node --from=production-dependencies /workspace/automations/invoice-processing/node_modules ./node_modules
# The prompts the steps send, loaded from beside dist/ (src/prompts.ts): extract-documents v1
# and verify-documents v1.
COPY --chown=node:node automations/invoice-processing/prompts ./prompts
# The ONE manifest version this image serves (src/automation.ts SERVED_VERSIONS): one image
# per version (the platform's D2) — v6's container keeps its own pinned digest until it is
# retired. The runner refuses a run pinned to any other (src/main.ts reads this dir).
COPY --chown=node:node manifests/invoice-processing.v7.json ./manifests/

LABEL org.opencontainers.image.source="https://github.com/siddak1234/snoopy-automations"

USER node
EXPOSE 8080
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/main.js"]
