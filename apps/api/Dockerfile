# syntax=docker/dockerfile:1

# =============================================================================
# Multi-stage build for the API.
#
# Three stages, and the split is not cosmetic: the final image contains no compiler, no
# dev dependencies, no test files and no source. That matters for size, but far more for
# attack surface — a build toolchain in a production image is a set of tools an attacker
# does not have to bring with them.
# =============================================================================

# -----------------------------------------------------------------------------
# Stage 1: dependencies
#
# LAYER ORDERING IS THE WHOLE POINT OF THIS STAGE. Only the manifests are copied before
# `npm ci`, so Docker's cache key for the install layer is the lockfile — not the source.
# Editing a TypeScript file therefore reuses the cached install, which is the difference
# between a 10-second rebuild and a 2-minute one. Copying the whole context first (the
# obvious way) invalidates the install on every source change.
# -----------------------------------------------------------------------------
FROM node:22-alpine AS deps
WORKDIR /app

COPY package.json package-lock.json ./
COPY apps/api/package.json ./apps/api/
COPY apps/web/package.json ./apps/web/

# `npm ci` rather than `npm install`: installs the lockfile exactly and fails if the
# manifests disagree with it, so an image can never be built from a dependency tree that
# was never reviewed.
RUN npm ci --workspace=apps/api --include-workspace-root

# -----------------------------------------------------------------------------
# Stage 2: build
# -----------------------------------------------------------------------------
FROM node:22-alpine AS build
WORKDIR /app

# npm workspaces HOIST dependencies to the root node_modules, so there is no
# apps/api/node_modules to copy — the root one covers both workspaces.
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json tsconfig.base.json ./
COPY apps/api ./apps/api

RUN npm run build --workspace=apps/api

# Prune to production dependencies AFTER compiling. Doing it before would remove
# TypeScript and the Nest CLI, which the build needs.
RUN npm prune --omit=dev --workspace=apps/api --include-workspace-root

# -----------------------------------------------------------------------------
# Stage 3: runtime
# -----------------------------------------------------------------------------
FROM node:22-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production

# NON-ROOT. The node image ships an unprivileged `node` user (uid 1000); creating one is
# unnecessary. Running as root inside a container means a container escape starts with
# root on the host, and it is one line to avoid.
#
# `--chown` on COPY rather than a separate `chown` layer: a recursive chown afterwards
# duplicates every file into a new layer, roughly doubling the image size.
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/apps/api/dist ./apps/api/dist
COPY --from=build --chown=node:node /app/apps/api/package.json ./apps/api/

USER node

# Cloud Run injects PORT and expects the container to listen on it.
ENV PORT=8080
EXPOSE 8080

# `node` directly, NOT `npm start`. npm sits between the init process and node, and does
# not forward SIGTERM to its child — so the graceful shutdown handler never runs and
# every deploy kills in-flight requests. This one line is what makes the draining logic
# in main.ts actually reachable.
CMD ["node", "apps/api/dist/main.js"]
