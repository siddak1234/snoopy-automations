# syntax=docker/dockerfile:1

# The image of one automation, built from the repository root:
#   docker build --file automations/example/Dockerfile .
# Replace `example` with your templateId everywhere in this file.
#
# The flow's own lock is the image's only lock: the build stage installs
# automations/example/package-lock.json, packing the local SDK into node_modules (its
# package.json alone until it is built, then again with its dist), and compiles the SDK and
# the automation with the TypeScript that lock pins; /workspace/node_modules points at that
# install, so the SDK finds it too. No root lock, root package.json or root tsconfig.json is
# copied, so a new flow's merge changes no input of this image (README, "Build a flow"). The
# runtime install below consumes the same lock without its dev tools.
#
# Only this automation's files, the SDK's and tsconfig.base.json are copied, so one
# automation's image never sees another's files (ADR-0034 §6).
#
# The one FROM that names an image, `base`: the same Node by tag and index digest in every flow,
# and every stage builds FROM it, since Dependabot moves only a Dockerfile's first FROM (README,
# "Working here", pinned base images).
FROM node:22.23.4-alpine@sha256:0e1754758c2df4cfa3e68d59e2e1b7374bb7fd9ea6328eaaacf15cc934af8202 AS base

FROM base AS build
WORKDIR /workspace

COPY tsconfig.base.json ./
COPY packages/automation-sdk/package.json packages/automation-sdk/tsconfig.json ./packages/automation-sdk/
COPY automations/example/package.json automations/example/package-lock.json automations/example/tsconfig.json ./automations/example/
WORKDIR /workspace/automations/example
RUN npm ci --ignore-scripts --workspaces=false --install-links=true \
  && ln -s automations/example/node_modules /workspace/node_modules

WORKDIR /workspace/packages/automation-sdk
COPY packages/automation-sdk/src ./src
RUN npm run build

WORKDIR /workspace/automations/example
RUN npm ci --ignore-scripts --workspaces=false --install-links=true
COPY automations/example/src ./src
RUN npm run build

FROM base AS production-dependencies
WORKDIR /workspace

# `--install-links` packs the local SDK instead of leaving a symlink to a build
# tree the runtime image does not contain. Its package exports only built `dist`.
COPY --from=build /workspace/packages/automation-sdk/package.json ./packages/automation-sdk/package.json
COPY --from=build /workspace/packages/automation-sdk/dist ./packages/automation-sdk/dist
COPY automations/example/package.json automations/example/package-lock.json ./automations/example/
WORKDIR /workspace/automations/example
RUN npm ci --omit=dev --ignore-scripts --workspaces=false --install-links=true

FROM base AS runtime
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
# The ONE manifest version this image serves: one image per version. The runner runs
# the pipeline it declares and refuses a run pinned to any other (src/main.ts reads
# this dir); test/conformance.test.ts holds every Dockerfile to exactly one file.
COPY --chown=node:node manifests/example.v1.json ./manifests/

LABEL org.opencontainers.image.source="https://github.com/siddak1234/snoopy-automations"

USER node
EXPOSE 8080
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/main.js"]
