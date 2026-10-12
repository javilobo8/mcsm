ARG NODE_VERSION=26.11.1
ARG PNPM_VERSION=12.10.1

FROM node:${NODE_VERSION}-alpine AS build
ARG PNPM_VERSION
RUN npm install -g pnpm@${PNPM_VERSION}
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY panel ./panel
COPY proto/fixtures ./proto/fixtures
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @mcsm/web build
# Deja solo las dependencias de producción de la API (tsx incluido); el dist de la web se conserva.
RUN pnpm install --frozen-lockfile --prod --filter "@mcsm/api..."
# Fuera lo que no hace falta en ejecución: tests, fuentes de la web y fixtures.
RUN rm -rf panel/apps/api/test panel/apps/web/src proto

FROM node:${NODE_VERSION}-alpine
WORKDIR /app
COPY --from=build /app /app
RUN mkdir -p /data && chown node:node /data
ENV NODE_ENV=production PORT=8080 DATA_DIR=/data WEB_DIST=/app/panel/apps/web/dist
VOLUME ["/data"]
EXPOSE 8080
USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
WORKDIR /app/panel/apps/api
# No usar node_modules/.bin/tsx: con pnpm es un script de shell, no JavaScript.
CMD ["node", "--import", "tsx", "src/main.ts"]
