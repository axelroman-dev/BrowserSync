# Multi-stage build: compile TypeScript, then ship only the compiled output
# and production dependencies. Keeps the final image small and avoids
# shipping the TS compiler / drizzle-kit / source into production.
#
# The base image is pinned by digest so every build of a release is the same,
# and Dependabot opens a PR when a newer one (a Node security patch, say) is
# out. Its Node major must match server/.node-version - CI checks that.

FROM node:24-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205 AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:24-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205 AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY --from=build /app/src/db/migrations ./src/db/migrations
COPY drizzle.config.ts ./
COPY public ./public

# Run as the unprivileged "node" user the base image already ships with,
# rather than root - if the app is ever compromised (a dependency RCE, say),
# this limits what it can do to the rest of the container.
RUN chown -R node:node /app
USER node

EXPOSE 3000

# Run pending migrations, then start the server. Safe on every restart -
# drizzle skips migrations it has already applied.
CMD ["sh", "-c", "node dist/db/migrate.js && node dist/index.js"]
