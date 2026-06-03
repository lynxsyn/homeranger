# syntax=docker/dockerfile:1.7
# homeranger processor (BullMQ worker) image. Mirrors apps/api/Dockerfile
# (multi-stage pnpm build, prisma generate, src/*.ts -> dist/*.js exports
# rewrite) but builds + runs apps/processor instead of apps/api.
#
# Doxus ships ONE image (doxus-api) and runs the worker off it via a CMD
# override. homeranger ships a DEDICATED homeranger-processor image so the
# processor Deployment needs no command override and the api/processor images
# scale + roll out independently. Build context is the monorepo root
# (release.yml passes `context: .`).
#
# Prisma client IS generated here (the worker's repositories use @prisma/client),
# but migrations are NOT applied by this image — the api Dockerfile's
# prisma-migrate init container owns `prisma migrate deploy`.
FROM node:24.15.0-alpine AS base
RUN corepack enable && corepack prepare pnpm@10.34.1 --activate
WORKDIR /app
ARG DATABASE_URL=postgresql://ci:ci@localhost:5432/homeranger_ci
ENV DATABASE_URL=$DATABASE_URL

# Install ALL deps. --ignore-scripts blocks postinstall worms inside the image;
# pnpm rebuild in the build stage re-runs scripts ONLY for the .npmrc allowlist.
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/processor/package.json apps/processor/
COPY packages/backend-core/package.json packages/backend-core/
COPY packages/shared/package.json packages/shared/
# The processor uses the api package's prisma schema to generate the client.
COPY apps/api/package.json apps/api/
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
RUN cd apps/processor && pnpm build

# Production image
FROM base AS runner
# Bake the git commit SHA so the worker can report it in /metrics labels / logs.
# release.yml passes --build-arg GIT_SHA=${github.sha}; local builds pass HEAD.
ARG GIT_SHA=unknown
ENV GIT_SHA=${GIT_SHA}
COPY --chown=node:node --from=deps /app/node_modules ./node_modules
COPY --chown=node:node --from=deps /app/apps/processor/node_modules ./apps/processor/node_modules
COPY --chown=node:node --from=deps /app/apps/api/node_modules ./apps/api/node_modules
COPY --chown=node:node --from=deps /app/packages/backend-core/node_modules ./packages/backend-core/node_modules
COPY --chown=node:node --from=build /app/package.json ./
COPY --chown=node:node --from=build /app/apps/processor/dist ./apps/processor/dist
COPY --chown=node:node --from=build /app/apps/processor/package.json ./apps/processor/
# The api package carries the prisma schema the worker generates its client from.
COPY --chown=node:node --from=build /app/apps/api/prisma ./apps/api/prisma
COPY --chown=node:node --from=build /app/apps/api/prisma.config.ts ./apps/api/
COPY --chown=node:node --from=build /app/apps/api/package.json ./apps/api/
COPY --chown=node:node --from=build /app/packages/backend-core/dist ./packages/backend-core/dist
COPY --chown=node:node --from=build /app/packages/backend-core/package.json ./packages/backend-core/
COPY --chown=node:node --from=build /app/packages/shared/dist ./packages/shared/dist
COPY --chown=node:node --from=build /app/packages/shared/package.json ./packages/shared/
# Rewrite the workspace package exports from ./src/*.ts -> ./dist/*.js (.d.ts for
# types) so the runtime resolves built JS, not TS sources. Verbatim from the api
# Dockerfile (which is verbatim from Doxus).
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

# Generate the Prisma client in the final image for the correct alpine engine
# binaries (the worker's repositories import @prisma/client).
RUN --mount=type=cache,target=/root/.cache/prisma,sharing=locked \
    cd apps/api && npx prisma generate

EXPOSE 9090
USER node
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://localhost:9090/metrics || exit 1
CMD ["node", "apps/processor/dist/worker.js"]
