# syntax=docker/dockerfile:1.7
# homeranger API image. Mirrors doxus-web/apps/control-plane-api/Dockerfile
# (multi-stage, pnpm, prisma generate twice, rewrite shared/backend-core
# package exports from src/*.ts → dist/*.js so the runtime resolves built JS),
# minus Sentry/instrumentation and the processor/scheduler stages (those apps
# are empty skeletons in homeranger — add their build+copy lines when they gain
# code). Build context is the monorepo root (release.yml passes `context: .`).
FROM node:24.15.0-alpine AS base
RUN corepack enable && corepack prepare pnpm@10.34.1 --activate
WORKDIR /app
ARG DATABASE_URL=postgresql://ci:ci@localhost:5432/homeranger_ci
ENV DATABASE_URL=$DATABASE_URL

# Install ALL deps. --ignore-scripts blocks postinstall worms inside the image;
# pnpm rebuild in the build stage re-runs scripts ONLY for the .npmrc allowlist.
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/api/package.json apps/api/
COPY packages/backend-core/package.json packages/backend-core/
COPY packages/shared/package.json packages/shared/
RUN --mount=type=cache,target=/root/.local/share/pnpm/store,sharing=locked \
    pnpm install --frozen-lockfile --ignore-scripts

# Build TypeScript. Rebuild the .npmrc-allowlisted packages whose install
# scripts we suppressed in deps (prisma engines + esbuild binaries).
FROM base AS build
COPY --from=deps /app/ ./
COPY . .
RUN --mount=type=cache,target=/root/.local/share/pnpm/store,sharing=locked \
    pnpm rebuild @prisma/client @prisma/engines prisma esbuild
RUN --mount=type=cache,target=/root/.cache/prisma,sharing=locked \
    cd apps/api && npx prisma generate
RUN cd packages/shared && pnpm build
RUN cd packages/backend-core && pnpm build
RUN cd apps/api && pnpm build

# Production image
FROM base AS runner
# Bake the git commit SHA into the image so /api/version reports the exact
# commit that built it. release.yml passes --build-arg GIT_SHA=${github.sha};
# local/imperative builds pass --build-arg GIT_SHA=$(git rev-parse HEAD).
# This is what app-mode post-release verify greps for (NOT the semver tag).
ARG GIT_SHA=unknown
ENV GIT_SHA=${GIT_SHA}
COPY --chown=node:node --from=deps /app/node_modules ./node_modules
COPY --chown=node:node --from=deps /app/apps/api/node_modules ./apps/api/node_modules
COPY --chown=node:node --from=deps /app/packages/backend-core/node_modules ./packages/backend-core/node_modules
COPY --chown=node:node --from=build /app/package.json ./
COPY --chown=node:node --from=build /app/apps/api/dist ./apps/api/dist
COPY --chown=node:node --from=build /app/apps/api/prisma ./apps/api/prisma
COPY --chown=node:node --from=build /app/apps/api/prisma.config.ts ./apps/api/
COPY --chown=node:node --from=build /app/apps/api/package.json ./apps/api/
COPY --chown=node:node --from=build /app/packages/backend-core/dist ./packages/backend-core/dist
COPY --chown=node:node --from=build /app/packages/backend-core/package.json ./packages/backend-core/
COPY --chown=node:node --from=build /app/packages/shared/dist ./packages/shared/dist
COPY --chown=node:node --from=build /app/packages/shared/package.json ./packages/shared/
# Rewrite the workspace package exports from ./src/*.ts → ./dist/*.js (.d.ts for
# types) so the runtime resolves built JS, not TS sources. Verbatim from Doxus.
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

# Generate Prisma client in the final image for the correct alpine engine binaries.
RUN --mount=type=cache,target=/root/.cache/prisma,sharing=locked \
    cd apps/api && npx prisma generate

EXPOSE 3000
USER node
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://localhost:3000/api/health || exit 1
CMD ["node", "apps/api/dist/main.js"]
