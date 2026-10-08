# Build from repository ROOT with --file cms/Dockerfile. Its Dockerfile.dockerignore
# overrides the root ignore (which intentionally excludes scripts for other images).
# npm 12.2.0 still ships brace-expansion 5.0.9 and undici 6.28.0; replace only
# those nested packages with fixed upstreams while retaining npm in each stage.
FROM node:24-alpine3.23@sha256:9ec4a2e289874ed0d722e1772ec2de45d2801541db8612f3638b26f128c69ac2 AS dependencies
WORKDIR /app/cms
RUN apk upgrade --no-cache \
 && npm install --global npm@12.2.0 \
 && npm install --prefix /tmp/npm-security-fix --no-save --ignore-scripts --package-lock=false brace-expansion@5.0.11 undici@6.28.1 \
 && rm -rf /usr/local/lib/node_modules/npm/node_modules/brace-expansion \
 && cp -R /tmp/npm-security-fix/node_modules/brace-expansion /usr/local/lib/node_modules/npm/node_modules/brace-expansion \
 && rm -rf /usr/local/lib/node_modules/npm/node_modules/undici \
 && cp -R /tmp/npm-security-fix/node_modules/undici /usr/local/lib/node_modules/npm/node_modules/undici \
 && rm -rf /tmp/npm-security-fix \
 && test "$(npm --version)" = "12.2.0" \
 && test "$(node -p 'require("/usr/local/lib/node_modules/npm/node_modules/brace-expansion/package.json").version')" = "5.0.11" \
 && test "$(node -p 'require("/usr/local/lib/node_modules/npm/node_modules/undici/package.json").version')" = "6.28.1"
COPY cms/package.json cms/package-lock.json ./
RUN npm ci

FROM node:24-alpine3.23@sha256:9ec4a2e289874ed0d722e1772ec2de45d2801541db8612f3638b26f128c69ac2 AS api-dependencies
WORKDIR /app/api
# The producer uses createRequire(/app/api/package.json), including sharp/pg.
# Install that locked production graph explicitly; no accidental CMS hoist/symlink.
RUN apk upgrade --no-cache \
 && npm install --global npm@12.2.0 \
 && npm install --prefix /tmp/npm-security-fix --no-save --ignore-scripts --package-lock=false brace-expansion@5.0.11 undici@6.28.1 \
 && rm -rf /usr/local/lib/node_modules/npm/node_modules/brace-expansion \
 && cp -R /tmp/npm-security-fix/node_modules/brace-expansion /usr/local/lib/node_modules/npm/node_modules/brace-expansion \
 && rm -rf /usr/local/lib/node_modules/npm/node_modules/undici \
 && cp -R /tmp/npm-security-fix/node_modules/undici /usr/local/lib/node_modules/npm/node_modules/undici \
 && rm -rf /tmp/npm-security-fix \
 && test "$(npm --version)" = "12.2.0" \
 && test "$(node -p 'require("/usr/local/lib/node_modules/npm/node_modules/brace-expansion/package.json").version')" = "5.0.11" \
 && test "$(node -p 'require("/usr/local/lib/node_modules/npm/node_modules/undici/package.json").version')" = "6.28.1"
COPY api/package.json api/package-lock.json ./
RUN npm ci --omit=dev --omit=optional \
 && npm install --no-save --ignore-scripts --omit=dev --omit=optional \
      @img/sharp-linuxmusl-x64@0.35.5 \
      @img/sharp-libvips-linuxmusl-x64@1.3.4

# Rebuild only esbuild's native executable from its same upstream v0.28.2 Go
# module. The pinned official patched toolchain avoids shipping its old Go stdlib.
FROM --platform=$BUILDPLATFORM golang:1.26.6-alpine3.23@sha256:e57c41c1d5864341031181b0db34b9a537bb5773eb6428e4e5bdaea0f9135406 AS esbuild-builder
ARG TARGETOS TARGETARCH
ENV GOPROXY=https://proxy.golang.org GOSUMDB=sum.golang.org GOTOOLCHAIN=local CGO_ENABLED=0
WORKDIR /build
COPY cms/go-build/go.mod cms/go-build/go.sum ./
RUN test "$(go version | awk '{print $3}')" = "go1.26.6" \
 && test "$TARGETOS/$TARGETARCH" = "linux/amd64" \
 && go mod download all \
 && mkdir -p /out \
 && GOOS="$TARGETOS" GOARCH="$TARGETARCH" go build -mod=readonly -trimpath -buildvcs=false -o /out/esbuild github.com/evanw/esbuild/cmd/esbuild \
 && test "$(/out/esbuild --version)" = "0.28.2" \
 && go version -m /out/esbuild | grep -F 'go1.26.6' \
 && go version -m /out/esbuild | grep -F 'v0.28.2' \
 && go version -m /out/esbuild | grep -F 'h1:A2uETn4jrQTcXaT/shwTDTYBxDjl7fV7nXmUrJxfA2w='

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
COPY --from=esbuild-builder /out/esbuild ./node_modules/@esbuild/linux-x64/bin/esbuild
RUN npm run build

FROM dependencies AS runtime-dependencies
RUN npm prune --omit=dev

FROM node:24-alpine3.23@sha256:9ec4a2e289874ed0d722e1772ec2de45d2801541db8612f3638b26f128c69ac2 AS runtime
WORKDIR /app/cms
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
RUN apk upgrade --no-cache \
 && npm install --global npm@12.2.0 \
 && npm install --prefix /tmp/npm-security-fix --no-save --ignore-scripts --package-lock=false brace-expansion@5.0.11 undici@6.28.1 \
 && rm -rf /usr/local/lib/node_modules/npm/node_modules/brace-expansion \
 && cp -R /tmp/npm-security-fix/node_modules/brace-expansion /usr/local/lib/node_modules/npm/node_modules/brace-expansion \
 && rm -rf /usr/local/lib/node_modules/npm/node_modules/undici \
 && cp -R /tmp/npm-security-fix/node_modules/undici /usr/local/lib/node_modules/npm/node_modules/undici \
 && rm -rf /tmp/npm-security-fix \
 && test "$(npm --version)" = "12.2.0" \
 && test "$(node -p 'require("/usr/local/lib/node_modules/npm/node_modules/brace-expansion/package.json").version')" = "5.0.11" \
 && test "$(node -p 'require("/usr/local/lib/node_modules/npm/node_modules/undici/package.json").version')" = "6.28.1"
COPY --from=build --chown=node:node /app/cms/package.json /app/cms/package-lock.json ./
# Keep the official Payload CLI and its TypeScript loader; do not standalone-prune.
COPY --from=runtime-dependencies --chown=node:node /app/cms/node_modules ./node_modules
# Keep the npm esbuild@0.28.2 JavaScript package paired with its verified upstream
# v0.28.2 executable rebuilt using Go 1.26.6.
COPY --from=esbuild-builder --chown=node:node /out/esbuild /app/cms/node_modules/@esbuild/linux-x64/bin/esbuild
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
