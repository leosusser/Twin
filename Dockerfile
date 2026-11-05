# Twin app image: production dependencies and source only. Data lives in volumes.
FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production OPENSSL_CONF=/dev/null HOST=0.0.0.0 PORT=4173 \
    TWIN_ASSET_DIR=/data/assets
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
COPY public ./public
COPY db ./db
COPY data/style-references ./data/style-references
RUN mkdir -p /data/assets && chown -R node:node /data
USER node
EXPOSE 4173
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD wget -qO- http://127.0.0.1:4173/healthz || exit 1
# Apply database migrations, then start the server (which runs the worker).
CMD ["sh", "-c", "node src/storage/migrate.ts && exec node src/server.ts"]
