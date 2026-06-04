# syntax=docker/dockerfile:1.7
# homeranger web (SPA) image. Mirrors doxus-web/apps/web/Dockerfile: build the
# Vite bundle, serve it via nginx (non-root). homeranger differences: serves on
# 8080 (matches the k8s Service + tunnel.tf ingress), no Sentry/Google-picker
# build ARGs, and builds shared + backend-core in-image first because the SPA
# imports `inferRouterOutputs` types from @homeranger/backend-core. Build context
# is the monorepo root (release.yml passes `context: .`).
FROM node:24.15.0-alpine AS base
RUN corepack enable && corepack prepare pnpm@10.34.1 --activate
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/web/package.json apps/web/
COPY packages/backend-core/package.json packages/backend-core/
COPY packages/shared/package.json packages/shared/
RUN --mount=type=cache,target=/root/.local/share/pnpm/store,sharing=locked \
    pnpm install --frozen-lockfile --ignore-scripts

FROM base AS build
COPY --from=deps /app/ ./
COPY . .
RUN --mount=type=cache,target=/root/.local/share/pnpm/store,sharing=locked \
    pnpm rebuild @prisma/client @prisma/engines prisma esbuild
# The web app's `import type { AppRouter }` from @homeranger/backend-core resolves
# against the package's TS sources at build time (Vite/tsc), but prisma client
# types are needed for backend-core to typecheck cleanly during the bundle.
RUN cd apps/api && npx prisma generate
RUN cd packages/shared && pnpm build
RUN cd packages/backend-core && pnpm build
# PUBLIC Supabase config baked into the SPA bundle (passed by release.yml from
# repo variables). Both are publishable client-side values — no secret. Exposed
# as env so Vite reads them as import.meta.env.VITE_* during the build.
ARG VITE_SUPABASE_URL=""
ARG VITE_SUPABASE_ANON_KEY=""
# MapTiler basemap key — a publishable, domain-restricted client value passed by
# release.yml from a repo SECRET. When empty the map falls back to the keyless
# Carto basemap, so the build never fails for want of it.
ARG VITE_MAPTILER_KEY=""
ENV VITE_SUPABASE_URL=${VITE_SUPABASE_URL}
ENV VITE_SUPABASE_ANON_KEY=${VITE_SUPABASE_ANON_KEY}
ENV VITE_MAPTILER_KEY=${VITE_MAPTILER_KEY}
RUN cd apps/web && pnpm build && find dist/assets -type f -name '*.map' -delete

FROM nginx:1.30-alpine AS runner
RUN mkdir -p /var/cache/nginx /var/run/nginx /tmp && \
    chown -R nginx:nginx /var/cache/nginx /var/run/nginx /tmp /usr/share/nginx/html
COPY --chown=nginx:nginx --from=build /app/apps/web/dist /usr/share/nginx/html
COPY --chown=nginx:nginx apps/web/nginx.conf /etc/nginx/nginx.conf
USER nginx
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://localhost:8080/ || exit 1
