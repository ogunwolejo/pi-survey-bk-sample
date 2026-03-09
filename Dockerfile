# syntax=docker/dockerfile:1

# Stage 1: Base with build tools for native modules (bcrypt, pg-native)
FROM node:20-alpine AS base
WORKDIR /usr/src/app
RUN apk add --no-cache python3 make g++ && rm -rf /var/cache/apk/*

# Stage 2: Runtime base (no build tools = smaller image)
FROM node:20-alpine AS runtime-base
WORKDIR /usr/src/app

# Stage 3: Install ALL dependencies (dev + prod) for building
FROM base AS deps
COPY package.json yarn.lock ./
COPY prisma ./prisma/
COPY prisma.config.ts ./
RUN yarn install --frozen-lockfile && \
    npx prisma generate

# Stage 4: Production dependencies only (prisma CLI must be here for migrations)
FROM base AS prod-deps
COPY package.json yarn.lock ./
COPY prisma ./prisma/
COPY prisma.config.ts ./
RUN yarn install --frozen-lockfile --production=true && yarn cache clean
# Copy generated Prisma client
COPY --from=deps /usr/src/app/node_modules/.prisma ./node_modules/.prisma
COPY --from=deps /usr/src/app/node_modules/@prisma/client ./node_modules/@prisma/client

# Stage 5: Build TypeScript
FROM deps AS build
COPY . .
RUN yarn build

# Stage 6: Production runtime (minimal image)
FROM runtime-base AS runtime
RUN if ! id node >/dev/null 2>&1; then \
        addgroup -g 1001 -S nodejs && \
        adduser -S node -u 1001 -G nodejs; \
    else \
        addgroup -g 1001 -S nodejs 2>/dev/null || true && \
        addgroup node nodejs 2>/dev/null || true; \
    fi

COPY --from=prod-deps --chown=node:nodejs /usr/src/app/node_modules ./node_modules
COPY --from=build --chown=node:nodejs /usr/src/app/dist ./dist
COPY --from=build --chown=node:nodejs /usr/src/app/package.json ./package.json
COPY --from=build --chown=node:nodejs /usr/src/app/prisma ./prisma
COPY --from=build --chown=node:nodejs /usr/src/app/prisma.config.ts ./prisma.config.ts

USER node

ENV PORT=3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=30s --retries=3 \
    CMD node -e "require('http').get('http://localhost:' + (process.env.PORT || 3000) + '/health', (r) => process.exit(r.statusCode === 200 ? 0 : 1))" || exit 1

EXPOSE ${PORT}
CMD ["node", "dist/entrypoint.js"]