FROM node:24.12.0-alpine3.23@sha256:c921b97d4b74f51744057454b306b418cf693865e73b8100559189605f6955b8
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --omit=optional \
 && npm install --no-save --ignore-scripts --omit=dev \
      @img/sharp-linuxmusl-x64@0.35.3 \
      @img/sharp-libvips-linuxmusl-x64@1.3.2
COPY --chown=node:node . .
RUN apk upgrade --no-cache \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx \
 && mkdir -p /app/uploads \
 && chown node:node /app/uploads \
 && chmod +x /app/db/docker-entrypoint.sh
USER node
ENTRYPOINT ["/app/db/docker-entrypoint.sh"]
CMD ["node", "index.js"]
