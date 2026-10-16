# syntax=docker/dockerfile:1

FROM node:26-slim AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# Generated files are not in the tree, so `build` runs codegen before Vite.
RUN npm run build

# Optional: docker build --target test
FROM builder AS test
CMD ["npm", "test"]

FROM node:26-slim AS runtime
# Links the GHCR package to the repository, so it is listed there and takes the repository's permissions.
LABEL org.opencontainers.image.source=https://github.com/cubicecho/heautou
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# The server isn't compiled. Its sources are the build output.
COPY server server
COPY --from=builder /app/dist dist

ENV NODE_ENV=production
ENV PORT=3000
ENV DATA_DIR=/data
# Made and handed to node before VOLUME, so a fresh named volume starts out writable by it.
RUN mkdir -p /data && chown node:node /data
VOLUME /data
EXPOSE 3000
USER node

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Exec form, so node is PID 1 and gets SIGTERM itself (stopOnSignals).
CMD ["node", "server/index.ts"]
