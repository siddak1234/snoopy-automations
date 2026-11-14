# syntax=docker/dockerfile:1

# The image of Invoice Processing v9, built from the repository root:
#   docker build --file automations/invoice-processing/Dockerfile .
#
# The flow's own lock is the image's only lock: the build stage installs
# automations/invoice-processing/package-lock.json, packing the local SDK and kit into
# node_modules (each one's package.json alone until it is built, then again with its dist),
# and compiles the SDK, the kit and the automation with the TypeScript that lock pins;
# /workspace/node_modules points at that install, so the SDK and kit find it too. No root
# lock, root package.json or root tsconfig.json is copied, so a new flow's merge changes no
# input of this image (README, "Build a flow"). The runtime install below consumes the same
# lock without its dev tools.
#
# Only this automation's files, the SDK's, the kit's and tsconfig.base.json are copied, so the
# image carries its own copy of each and shares nothing at run time with another automation
# (ADR-0034 §6).
#
# The one FROM that names an image, `base`: the same Node by tag and index digest in every flow,
# and every stage builds FROM it, since Dependabot moves only a Dockerfile's first FROM (README,
# "Working here", pinned base images).
FROM node:22.23.4-alpine@sha256:0e1754758c2df4cfa3e68d59e2e1b7374bb7fd9ea6328eaaacf15cc934af8202 AS base

FROM base AS build
WORKDIR /workspace

COPY tsconfig.base.json ./
COPY packages/automation-sdk/package.json packages/automation-sdk/tsconfig.json ./packages/automation-sdk/
COPY packages/automation-kit/package.json packages/automation-kit/tsconfig.json ./packages/automation-kit/
COPY automations/invoice-processing/package.json automations/invoice-processing/package-lock.json automations/invoice-processing/tsconfig.json ./automations/invoice-processing/
WORKDIR /workspace/automations/invoice-processing
RUN npm ci --ignore-scripts --workspaces=false --install-links=true \
  && ln -s automations/invoice-processing/node_modules /workspace/node_modules

WORKDIR /workspace/packages/automation-sdk
COPY packages/automation-sdk/src ./src
RUN npm run build

WORKDIR /workspace/automations/invoice-processing
RUN npm ci --ignore-scripts --workspaces=false --install-links=true

WORKDIR /workspace/packages/automation-kit
COPY packages/automation-kit/src ./src
RUN npm run build

WORKDIR /workspace/automations/invoice-processing
RUN npm ci --ignore-scripts --workspaces=false --install-links=true
COPY automations/invoice-processing/src ./src
RUN npm run build

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
# The prompts, loaded from beside dist/ (src/prompts.ts): v8 and v9 send extract-documents v2 and
# verify-documents v1; extract-documents v1 rides along, loaded and never sent.
COPY --chown=node:node automations/invoice-processing/prompts ./prompts
# The ONE manifest version this image serves (src/automation.ts SERVED_VERSIONS): one image
# per version (the platform's D2) — v8's container keeps its own pinned digest until it is
# retired. The runner refuses a run pinned to any other (src/main.ts reads this dir).
COPY --chown=node:node manifests/invoice-processing.v9.json ./manifests/

LABEL org.opencontainers.image.source="https://github.com/siddak1234/snoopy-automations"

USER node
EXPOSE 8080
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/main.js"]
