# syntax=docker/dockerfile:1

# The image of Resume Screening, v5 of candidate-reviewer, built from the repository root:
#   docker build --file automations/candidate-reviewer/Dockerfile .
#
# The flow's own lock is the image's only lock: the build stage installs
# automations/candidate-reviewer/package-lock.json, packing the local SDK into node_modules (its
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
COPY automations/candidate-reviewer/package.json automations/candidate-reviewer/package-lock.json automations/candidate-reviewer/tsconfig.json ./automations/candidate-reviewer/
WORKDIR /workspace/automations/candidate-reviewer
RUN npm ci --ignore-scripts --workspaces=false --install-links=true \
  && ln -s automations/candidate-reviewer/node_modules /workspace/node_modules

WORKDIR /workspace/packages/automation-sdk
COPY packages/automation-sdk/src ./src
RUN npm run build

WORKDIR /workspace/automations/candidate-reviewer
RUN npm ci --ignore-scripts --workspaces=false --install-links=true
COPY automations/candidate-reviewer/src ./src
RUN npm run build

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
# The prompts, loaded from beside dist/ (src/prompts.ts): v3 to v5 send extract-posting v1,
# extract-resume v2 and score-candidate v1; extract-resume v1 rides along, loaded and never sent.
COPY --chown=node:node automations/candidate-reviewer/prompts ./prompts
# The ONE manifest version this image serves (src/automation.ts SERVED_VERSIONS): one image per
# version (the platform's D2). The runner runs its pipeline, or its items.pipeline on an item
# run, and refuses a run pinned to any other version (src/main.ts reads this dir).
COPY --chown=node:node manifests/candidate-reviewer.v5.json ./manifests/

LABEL org.opencontainers.image.source="https://github.com/siddak1234/snoopy-automations"

USER node
EXPOSE 8080
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/main.js"]
