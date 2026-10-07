# Build from repository ROOT with --file cms/Dockerfile. Its Dockerfile.dockerignore
# overrides the root ignore (which intentionally excludes scripts for other images).
FROM node:24.12.0-alpine3.23@sha256:c921b97d4b74f51744057454b306b418cf693865e73b8100559189605f6955b8 AS dependencies
WORKDIR /app/cms
COPY cms/package.json cms/package-lock.json ./
RUN npm ci

FROM node:24.12.0-alpine3.23@sha256:c921b97d4b74f51744057454b306b418cf693865e73b8100559189605f6955b8 AS api-dependencies
WORKDIR /app/api
# The producer uses createRequire(/app/api/package.json), including sharp/pg.
# Install that locked production graph explicitly; no accidental CMS hoist/symlink.
COPY api/package.json api/package-lock.json ./
RUN npm ci --omit=dev

FROM dependencies AS sources
COPY cms/src/ ./src/
COPY cms/scripts/ ./scripts/
COPY cms/next.config.mjs cms/tsconfig.json cms/next-env.d.ts ./
COPY --from=api-dependencies /app/api/package.json /app/api/package-lock.json /app/api/
COPY --from=api-dependencies /app/api/node_modules /app/api/node_modules
COPY api/cms/blocks.js api/cms/locks.js api/cms/permissions.js /app/api/cms/
COPY api/owner-news/editorial.js api/owner-news/home.js api/owner-news/authority.js /app/api/owner-news/
COPY api/middleware/policy.js /app/api/middleware/
COPY scripts/import-owner-news.mjs /app/scripts/
COPY scripts/owner-news-payload/bundle.mjs scripts/owner-news-payload/contract.mjs scripts/owner-news-payload/files.mjs scripts/owner-news-payload/legacy-converter.mjs scripts/owner-news-payload/export.mjs scripts/owner-news-payload/cutover.mjs /app/scripts/owner-news-payload/

FROM sources AS build
# next.config.mjs supplies only synthetic, non-routable build configuration.
RUN npm run build

FROM dependencies AS runtime-dependencies
RUN npm prune --omit=dev

FROM node:24.12.0-alpine3.23@sha256:c921b97d4b74f51744057454b306b418cf693865e73b8100559189605f6955b8 AS runtime
WORKDIR /app/cms
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
COPY --from=build --chown=node:node /app/cms/package.json /app/cms/package-lock.json ./
# Keep the official Payload CLI and its TypeScript loader; do not standalone-prune.
COPY --from=runtime-dependencies --chown=node:node /app/cms/node_modules ./node_modules
COPY --from=build --chown=node:node /app/cms/.next ./.next
COPY --from=build --chown=node:node /app/cms/src ./src
COPY --from=build --chown=node:node /app/cms/scripts ./scripts
COPY --from=build --chown=node:node /app/cms/next.config.mjs /app/cms/tsconfig.json /app/cms/next-env.d.ts ./
# These trees contain only the allowlisted sources/dependencies from the stage above.
COPY --from=sources --chown=node:node /app/api /app/api
COPY --from=sources --chown=node:node /app/scripts /app/scripts
RUN mkdir -p /var/lib/ownerinc-cms/media && chown node:node /var/lib/ownerinc-cms/media && chmod 0700 /var/lib/ownerinc-cms/media
USER node
# Side-effect-free closure/native sharp smoke: no Payload init, database or network.
RUN node --import tsx scripts/check-runtime-packaging.mjs
EXPOSE 3001
CMD ["npm", "start"]
