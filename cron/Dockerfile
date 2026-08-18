FROM node:24.12.0-alpine3.23@sha256:c921b97d4b74f51744057454b306b418cf693865e73b8100559189605f6955b8
WORKDIR /app
COPY cron/package.json cron/package-lock.json ./
RUN npm ci --omit=dev --omit=optional
COPY --chown=node:node cron/ ./
COPY --chown=node:node api/cms/ /api/cms/
RUN apk upgrade --no-cache \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx
USER node
CMD ["node", "index.js"]
