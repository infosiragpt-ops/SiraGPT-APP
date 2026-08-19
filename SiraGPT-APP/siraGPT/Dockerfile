# ──────────────────────────────────────────────────────────────
# siraGPT — Frontend (Next.js)
# Multi-stage build: build → production runner
# ──────────────────────────────────────────────────────────────
# Usage during Docker Compose:
#   docker compose build frontend
#
# The DOCKER_BUILD=true env var triggers `output: 'standalone'`
# in next.config.mjs, producing a lean .next/standalone/ output.
# ──────────────────────────────────────────────────────────────

# ─── Stage 1: Build ──────────────────────────────────────────
FROM node:22-alpine AS build
WORKDIR /app

RUN apk add --no-cache libc6-compat

# Install deps separately for layer caching
COPY package.json package-lock.json ./
COPY backend/package.json backend/package-lock.json ./backend/
RUN npm ci --legacy-peer-deps --prefer-offline --no-audit --no-fund
RUN npm ci --prefix backend --omit=dev --legacy-peer-deps --prefer-offline --no-audit --no-fund

# Copy app source after dependency install so Docker can cache npm layers.
COPY . .

# Public client configuration is baked into the Next.js bundle at build time.
ARG NEXT_PUBLIC_API_URL=http://localhost:5000/api
ARG NEXT_PUBLIC_APP_NAME=siraGPT
ARG NEXT_PUBLIC_APP_DESCRIPTION="Multi-LLM AI Platform"
ARG NEXT_PUBLIC_URL=http://localhost:3000
ARG NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=
ARG NEXT_PUBLIC_POSTHOG_KEY=
ARG NEXT_PUBLIC_SENTRY_DSN=
ENV NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL}
ENV NEXT_PUBLIC_APP_NAME=${NEXT_PUBLIC_APP_NAME}
ENV NEXT_PUBLIC_APP_DESCRIPTION=${NEXT_PUBLIC_APP_DESCRIPTION}
ENV NEXT_PUBLIC_URL=${NEXT_PUBLIC_URL}
ENV NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=${NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY}
ENV NEXT_PUBLIC_POSTHOG_KEY=${NEXT_PUBLIC_POSTHOG_KEY}
ENV NEXT_PUBLIC_SENTRY_DSN=${NEXT_PUBLIC_SENTRY_DSN}

# Build with standalone output
ENV DOCKER_BUILD=true
ENV NEXT_TELEMETRY_DISABLED=1
# GitHub's Docker runner has less usable memory than the host build job.
# Keep Next's heap below the default package-script ceiling so BuildKit
# does not cancel the frontend image build under memory pressure.
ENV NODE_OPTIONS=--max-old-space-size=4096
RUN npm run build

# Prune dev dependencies
RUN npm prune --omit=dev --prefer-offline

# ─── Stage 2: Production runner ─────────────────────────────
FROM node:22-alpine AS runner
WORKDIR /app

RUN apk add --no-cache wget

# Security: run as non-root 'node' user (uid 1000 in alpine image)
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

# Set correct env
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV HOSTNAME=0.0.0.0
ENV PORT=3000

# ─── Copy standalone output ─────────────────────────────────
# Next.js `output: 'standalone'` copies minimal runtime files:
#   .next/standalone/  — server + config
#   .next/standalone/.next/static/  — client assets
#   public/  — public directory
COPY --from=build --chown=appuser:appgroup /app/.next/standalone ./
COPY --from=build --chown=appuser:appgroup /app/.next/standalone/.next/static ./.next/static
COPY --from=build --chown=appuser:appgroup /app/public ./public

# Switch to non-root user
USER appuser

EXPOSE 3000

# Healthcheck
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:3000/ || exit 1

# Run the standalone server directly
CMD ["node", "server.js"]
