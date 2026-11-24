# syntax=docker/dockerfile:1

# ---------- build: install everything, build client + server ----------
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY client/package.json client/
COPY loadtest/package.json loadtest/
RUN npm ci --no-audit --no-fund
COPY server server
COPY client client
RUN npm run build --workspace client && npm run build --workspace server

# ---------- runtime: server production deps + built assets only ----------
FROM node:24-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY client/package.json client/
COPY loadtest/package.json loadtest/
RUN npm ci --omit=dev --workspace server --no-audit --no-fund && npm cache clean --force
COPY --from=build /app/server/dist server/dist
COPY --from=build /app/client/dist client/dist
ENV CLIENT_DIST=/app/client/dist \
    PORT=4000
WORKDIR /app/server
USER node
EXPOSE 4000
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s CMD wget -qO- http://127.0.0.1:4000/api/health || exit 1
CMD ["node", "dist/index.js"]
