# syntax=docker/dockerfile:1

# The image of Resume Screening, v3 of candidate-reviewer, built from the repository root:
#   docker build --file automations/candidate-reviewer/Dockerfile .
#
# The SDK and automation are workspaces during development, so the build uses the
# root lock. The runtime install below is deliberately different: it consumes the
# automation's own lockfile and packs the already-built local SDK into node_modules.
#
# Only this automation's and the SDK's package.json are copied before `npm ci`: npm
# installs a root lock whose other workspaces are absent from disk, so one
# automation's image never sees another's files (ADR-0034 §6).
#
# The one FROM that names an image, `base`: the same Node by tag and index digest in every flow,
# and every stage builds FROM it, since Dependabot moves only a Dockerfile's first FROM (README,
# "Working here", pinned base images).
FROM node:22.23.4-alpine@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914 AS base

FROM base AS build
WORKDIR /workspace

COPY package.json package-lock.json tsconfig.base.json tsconfig.json ./
COPY packages/automation-sdk/package.json packages/automation-sdk/tsconfig.json ./packages/automation-sdk/
COPY automations/candidate-reviewer/package.json automations/candidate-reviewer/tsconfig.json ./automations/candidate-reviewer/
RUN npm ci --ignore-scripts

COPY packages/automation-sdk/src ./packages/automation-sdk/src
COPY automations/candidate-reviewer/src ./automations/candidate-reviewer/src
RUN npm run build --workspace @autom8x/automation-sdk \
  && npm run build --workspace @autom8x/candidate-reviewer

FROM base AS production-dependencies
WORKDIR /workspace

# `--install-links` packs the local SDK instead of leaving a symlink to a build
# tree the runtime image does not contain. Its package exports only built `dist`.
COPY --from=build /workspace/packages/automation-sdk/package.json ./packages/automation-sdk/package.json
COPY --from=build /workspace/packages/automation-sdk/dist ./packages/automation-sdk/dist
COPY automations/candidate-reviewer/package.json automations/candidate-reviewer/package-lock.json ./automations/candidate-reviewer/
WORKDIR /workspace/automations/candidate-reviewer
RUN npm ci --omit=dev --ignore-scripts --workspaces=false --install-links=true

FROM base AS runtime
RUN apk upgrade --no-cache && apk add --no-cache tini
ENV NODE_ENV=production
WORKDIR /app

# The entrypoint is Node itself; npm and its dependency tree are not runtime code.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

COPY --chown=node:node automations/candidate-reviewer/package.json ./
COPY --chown=node:node --from=build /workspace/automations/candidate-reviewer/dist ./dist
COPY --chown=node:node --from=production-dependencies /workspace/automations/candidate-reviewer/node_modules ./node_modules
# The prompts, loaded from beside dist/ (src/prompts.ts): v3 sends extract-posting v1,
# extract-resume v2 and score-candidate v1; extract-resume v1 rides along, loaded and never sent.
COPY --chown=node:node automations/candidate-reviewer/prompts ./prompts
# The ONE manifest version this image serves (src/automation.ts SERVED_VERSIONS): one image per
# version (the platform's D2). The runner runs its pipeline, or its items.pipeline on an item
# run, and refuses a run pinned to any other version (src/main.ts reads this dir).
COPY --chown=node:node manifests/candidate-reviewer.v3.json ./manifests/

LABEL org.opencontainers.image.source="https://github.com/siddak1234/snoopy-automations"

USER node
EXPOSE 8080
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/main.js"]
