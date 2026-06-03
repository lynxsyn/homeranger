# syntax=docker/dockerfile:1.7
# homeranger scheduler image (M6) — the leader-locked warmup:recalc cadence
# driver. Mirrors apps/processor/Dockerfile (multi-stage pnpm build, prisma
# generate for the @prisma/client the backend-core repos import,
# src/*.ts -> dist/*.js exports rewrite) but builds + runs apps/scheduler.
# Build context is the monorepo root (release.yml passes `context: .`).
#
# A dedicated image (not a CMD override on the processor) so the scheduler rolls
# out + scales independently. Migrations are owned by the api init container.
FROM node:24.15.0-alpine AS base
RUN corepack enable && corepack prepare pnpm@10.34.1 --activate
WORKDIR /app
ARG DATABASE_URL=postgresql://ci:ci@localhost:5432/homeranger_ci
ENV DATABASE_URL=$DATABASE_URL

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/scheduler/package.json apps/scheduler/
COPY packages/backend-core/package.json packages/backend-core/
COPY packages/shared/package.json packages/shared/
# The scheduler uses the api package's prisma schema to generate the client.
COPY apps/api/package.json apps/api/
RUN --mount=type=cache,target=/root/.local/share/pnpm/store,sharing=locked \
    pnpm install --frozen-lockfile --ignore-scripts

FROM base AS build
COPY --from=deps /app/ ./
COPY . .
RUN --mount=type=cache,target=/root/.local/share/pnpm/store,sharing=locked \
    pnpm rebuild @prisma/client @prisma/engines prisma esbuild
RUN --mount=type=cache,target=/root/.cache/prisma,sharing=locked \
    cd apps/api && npx prisma generate
RUN cd packages/shared && pnpm build
RUN cd packages/backend-core && pnpm build
RUN cd apps/scheduler && pnpm build

# Production image
FROM base AS runner
COPY --chown=node:node --from=deps /app/node_modules ./node_modules
COPY --chown=node:node --from=deps /app/apps/scheduler/node_modules ./apps/scheduler/node_modules
COPY --chown=node:node --from=deps /app/apps/api/node_modules ./apps/api/node_modules
COPY --chown=node:node --from=deps /app/packages/backend-core/node_modules ./packages/backend-core/node_modules
COPY --chown=node:node --from=build /app/package.json ./
COPY --chown=node:node --from=build /app/apps/scheduler/dist ./apps/scheduler/dist
COPY --chown=node:node --from=build /app/apps/scheduler/package.json ./apps/scheduler/
# The api package carries the prisma schema the backend-core repos generate from.
COPY --chown=node:node --from=build /app/apps/api/prisma ./apps/api/prisma
COPY --chown=node:node --from=build /app/apps/api/prisma.config.ts ./apps/api/
COPY --chown=node:node --from=build /app/apps/api/package.json ./apps/api/
COPY --chown=node:node --from=build /app/packages/backend-core/dist ./packages/backend-core/dist
COPY --chown=node:node --from=build /app/packages/backend-core/package.json ./packages/backend-core/
COPY --chown=node:node --from=build /app/packages/shared/dist ./packages/shared/dist
COPY --chown=node:node --from=build /app/packages/shared/package.json ./packages/shared/
# Rewrite the workspace package exports from ./src/*.ts -> ./dist/*.js (verbatim
# from the api/processor Dockerfiles).
RUN node - <<'NODE'
const fs = require("node:fs");

function rewritePackage(packageJsonPath) {
  const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));

  function rewriteValue(value, key) {
    if (typeof value === "string") {
      const next = value
        .replace(/^\.\/src\//, "./dist/")
        .replace(/^src\//, "dist/");
      return key === "types"
        ? next.replace(/\.ts$/, ".d.ts")
        : next.replace(/\.ts$/, ".js");
    }
    if (Array.isArray(value)) {
      return value.map((entry) => rewriteValue(entry, key));
    }
    if (value && typeof value === "object") {
      for (const [childKey, childValue] of Object.entries(value)) {
        value[childKey] = rewriteValue(childValue, childKey);
      }
    }
    return value;
  }

  if (typeof pkg.main === "string") {
    pkg.main = pkg.main.replace(/^src\//, "dist/").replace(/\.ts$/, ".js");
  }
  if (typeof pkg.types === "string") {
    pkg.types = pkg.types.replace(/^src\//, "dist/").replace(/\.ts$/, ".d.ts");
  }
  if (pkg.exports) {
    pkg.exports = rewriteValue(pkg.exports);
  }

  fs.writeFileSync(packageJsonPath, `${JSON.stringify(pkg, null, 2)}\n`);
}

rewritePackage("./packages/shared/package.json");
rewritePackage("./packages/backend-core/package.json");
NODE

RUN --mount=type=cache,target=/root/.cache/prisma,sharing=locked \
    cd apps/api && npx prisma generate

EXPOSE 9091
USER node
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://localhost:9091/health || exit 1
CMD ["node", "apps/scheduler/dist/scheduler.js"]
