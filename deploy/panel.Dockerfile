ARG PNPM_VERSION=12.10.1

# Base image pinned by digest (L11). To update it: docker buildx imagetools inspect node:<version>-alpine.
FROM node:26.11.1-alpine@sha256:143494b1da2945f061539253adc65e4f1569ddf07da2d384c022c791a9d90a4a AS build
ARG PNPM_VERSION
RUN npm install -g pnpm@${PNPM_VERSION}
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY panel ./panel
COPY proto/fixtures ./proto/fixtures
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @mcsm/web build
# Keep only the API's production dependencies (tsx included); the web dist is preserved.
RUN pnpm install --frozen-lockfile --prod --filter "@mcsm/api..."
# Remove what isn't needed at runtime: tests, web sources and fixtures.
RUN rm -rf panel/apps/api/test panel/apps/web/src proto

FROM node:26.11.1-alpine@sha256:143494b1da2945f061539253adc65e4f1569ddf07da2d384c022c791a9d90a4a
WORKDIR /app
COPY --from=build /app /app
RUN mkdir -p /data && chown node:node /data
# Agent image in the `docker run` from “Add node”. The release pins it to ghcr.io/<owner>/mcsm-agent:<version>;
# in a local build it is the hand-built agent. MCSM_AGENT_IMAGE overrides it at startup.
ARG AGENT_IMAGE=mcsm-agent:latest
ENV NODE_ENV=production PORT=8080 DATA_DIR=/data WEB_DIST=/app/panel/apps/web/dist MCSM_AGENT_IMAGE=${AGENT_IMAGE}
VOLUME ["/data"]
EXPOSE 8080
USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
WORKDIR /app/panel/apps/api
# Don't use node_modules/.bin/tsx: with pnpm it is a shell script, not JavaScript.
CMD ["node", "--import", "tsx", "src/main.ts"]
