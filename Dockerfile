FROM --platform=$BUILDPLATFORM node:20 AS builder

WORKDIR /calcom

## Build arguments
ARG NEXT_PUBLIC_LICENSE_CONSENT
ARG NEXT_PUBLIC_WEBSITE_TERMS_URL
ARG NEXT_PUBLIC_WEBSITE_PRIVACY_POLICY_URL
ARG CALCOM_TELEMETRY_DISABLED
ARG DATABASE_URL
ARG NEXTAUTH_SECRET=secret
ARG CALENDSO_ENCRYPTION_KEY=secret
ARG MAX_OLD_SPACE_SIZE=6144
ARG NEXT_PUBLIC_API_V2_URL
ARG CSP_POLICY
ARG NEXT_PUBLIC_SINGLE_ORG_SLUG
ARG ORGANIZATIONS_ENABLED

ENV NEXT_PUBLIC_WEBAPP_URL=http://NEXT_PUBLIC_WEBAPP_URL_PLACEHOLDER \
  NEXT_PUBLIC_API_V2_URL=$NEXT_PUBLIC_API_V2_URL \
  NEXT_PUBLIC_LICENSE_CONSENT=$NEXT_PUBLIC_LICENSE_CONSENT \
  NEXT_PUBLIC_WEBSITE_TERMS_URL=$NEXT_PUBLIC_WEBSITE_TERMS_URL \
  NEXT_PUBLIC_WEBSITE_PRIVACY_POLICY_URL=$NEXT_PUBLIC_WEBSITE_PRIVACY_POLICY_URL \
  CALCOM_TELEMETRY_DISABLED=$CALCOM_TELEMETRY_DISABLED \
  DATABASE_URL=$DATABASE_URL \
  DATABASE_DIRECT_URL=$DATABASE_URL \
  NEXTAUTH_SECRET=${NEXTAUTH_SECRET} \
  CALENDSO_ENCRYPTION_KEY=${CALENDSO_ENCRYPTION_KEY} \
  NEXT_PUBLIC_SINGLE_ORG_SLUG=$NEXT_PUBLIC_SINGLE_ORG_SLUG \
  ORGANIZATIONS_ENABLED=$ORGANIZATIONS_ENABLED \
  NODE_OPTIONS=--max-old-space-size=${MAX_OLD_SPACE_SIZE} \
  BUILD_STANDALONE=true \
  CSP_POLICY=$CSP_POLICY

# ============================================
# STEP 1: Copy dependency manifests only (cached layer)
# ============================================
COPY package.json yarn.lock .yarnrc.yml turbo.json ./
COPY .yarn ./.yarn

# Copy only package.json files from all workspaces (for dependency resolution)
# This allows yarn install to be cached when only source code changes
COPY apps/web/package.json ./apps/web/package.json
COPY apps/api/v2/package.json ./apps/api/v2/package.json
COPY packages/app-store/package.json ./packages/app-store/package.json
COPY packages/app-store-cli/package.json ./packages/app-store-cli/package.json
COPY packages/config/package.json ./packages/config/package.json
COPY packages/coss-ui/package.json ./packages/coss-ui/package.json
COPY packages/dayjs/package.json ./packages/dayjs/package.json
COPY packages/debugging/package.json ./packages/debugging/package.json
COPY packages/emails/package.json ./packages/emails/package.json
COPY packages/embeds/embed-core/package.json ./packages/embeds/embed-core/package.json
COPY packages/embeds/embed-react/package.json ./packages/embeds/embed-react/package.json
COPY packages/embeds/embed-snippet/package.json ./packages/embeds/embed-snippet/package.json
COPY packages/features/package.json ./packages/features/package.json
COPY packages/kysely/package.json ./packages/kysely/package.json
COPY packages/lib/package.json ./packages/lib/package.json
COPY packages/platform/atoms/package.json ./packages/platform/atoms/package.json
COPY packages/platform/constants/package.json ./packages/platform/constants/package.json
COPY packages/platform/enums/package.json ./packages/platform/enums/package.json
COPY packages/platform/libraries/package.json ./packages/platform/libraries/package.json
COPY packages/platform/types/package.json ./packages/platform/types/package.json
COPY packages/platform/utils/package.json ./packages/platform/utils/package.json
COPY packages/prisma/package.json ./packages/prisma/package.json
COPY packages/testing/package.json ./packages/testing/package.json
COPY packages/trpc/package.json ./packages/trpc/package.json
COPY packages/tsconfig/package.json ./packages/tsconfig/package.json
COPY packages/types/package.json ./packages/types/package.json
COPY packages/ui/package.json ./packages/ui/package.json

# ============================================
# STEP 2: Install dependencies (cached if package.json unchanged)
# ============================================
RUN yarn config set httpTimeout 1200000
RUN yarn install --immutable || yarn install

# ============================================
# STEP 3: Copy source code (invalidates on code changes)
# ============================================
COPY playwright.config.ts i18n.json ./
COPY apps/web ./apps/web
COPY apps/api/v2 ./apps/api/v2
COPY packages ./packages

# ============================================
# STEP 4: Build application
# ============================================
RUN npx turbo prune --scope=@calcom/web --scope=@calcom/trpc --docker
RUN yarn workspace @calcom/trpc run build
RUN yarn --cwd packages/embeds/embed-core workspace @calcom/embed-core run build
RUN yarn --cwd apps/web workspace @calcom/web run copy-app-store-static
RUN yarn --cwd apps/web workspace @calcom/web run build
RUN rm -rf node_modules/.cache .yarn/cache apps/web/.next/cache

FROM node:20 AS builder-two

WORKDIR /calcom
ARG NEXT_PUBLIC_WEBAPP_URL=http://localhost:3000

ENV NODE_ENV=production

COPY package.json .yarnrc.yml turbo.json i18n.json ./
COPY .yarn ./.yarn
COPY --from=builder /calcom/yarn.lock ./yarn.lock
COPY --from=builder /calcom/node_modules ./node_modules
COPY --from=builder /calcom/packages ./packages
COPY --from=builder /calcom/apps/web ./apps/web
COPY --from=builder /calcom/packages/prisma/schema.prisma ./prisma/schema.prisma
COPY scripts scripts
RUN chmod +x scripts/*

# Save value used during this build stage. If NEXT_PUBLIC_WEBAPP_URL and BUILT_NEXT_PUBLIC_WEBAPP_URL differ at
# run-time, then start.sh will find/replace static values again.
ENV NEXT_PUBLIC_WEBAPP_URL=$NEXT_PUBLIC_WEBAPP_URL \
  BUILT_NEXT_PUBLIC_WEBAPP_URL=$NEXT_PUBLIC_WEBAPP_URL

RUN scripts/replace-placeholder.sh http://NEXT_PUBLIC_WEBAPP_URL_PLACEHOLDER ${NEXT_PUBLIC_WEBAPP_URL}

FROM node:20 AS runner

WORKDIR /calcom

RUN apt-get update && apt-get install -y --no-install-recommends netcat-openbsd wget && rm -rf /var/lib/apt/lists/*

COPY --from=builder-two /calcom ./
ARG NEXT_PUBLIC_WEBAPP_URL=http://localhost:3000
ENV NEXT_PUBLIC_WEBAPP_URL=$NEXT_PUBLIC_WEBAPP_URL \
  BUILT_NEXT_PUBLIC_WEBAPP_URL=$NEXT_PUBLIC_WEBAPP_URL

ENV NODE_ENV=production
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=30s --retries=5 \
  CMD wget --spider http://localhost:3000 || exit 1

CMD ["/calcom/scripts/start.sh"]
