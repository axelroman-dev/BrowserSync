# Multi-stage build: compile TypeScript, then ship only the compiled output
# and production dependencies. Keeps the final image small and avoids
# shipping the TS compiler / drizzle-kit / source into production.

FROM node:20-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:20-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY --from=build /app/dist ./dist
COPY --from=build /app/src/db/migrations ./src/db/migrations
COPY drizzle.config.ts ./

# Run as the unprivileged "node" user the base image already ships with,
# rather than root - if the app is ever compromised (a dependency RCE, say),
# this limits what it can do to the rest of the container.
RUN chown -R node:node /app
USER node

EXPOSE 3000

# Run pending migrations, then start the server. Safe on every restart -
# drizzle skips migrations it has already applied.
CMD ["sh", "-c", "node dist/db/migrate.js && node dist/index.js"]
