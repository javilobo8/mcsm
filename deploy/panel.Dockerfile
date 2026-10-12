FROM node:26-alpine AS build
RUN npm install -g pnpm@12.10.1
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY panel ./panel
COPY proto/fixtures ./proto/fixtures
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @mcsm/web build
# Deja solo las dependencias de producción de la API (tsx incluido); el dist de la web se conserva.
RUN pnpm install --frozen-lockfile --prod --filter "@mcsm/api..."

FROM node:26-alpine
WORKDIR /app
COPY --from=build /app /app
ENV NODE_ENV=production PORT=8080 DATA_DIR=/data WEB_DIST=/app/panel/apps/web/dist
VOLUME ["/data"]
EXPOSE 8080
WORKDIR /app/panel/apps/api
# No usar node_modules/.bin/tsx: con pnpm es un script de shell, no JavaScript.
CMD ["node", "--import", "tsx", "src/main.ts"]
