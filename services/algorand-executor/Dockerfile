FROM node:24.19.0-alpine AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable
WORKDIR /workspace
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml turbo.json tsconfig.base.json ./
COPY packages/contracts/package.json packages/contracts/
COPY packages/domain/package.json packages/domain/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY services/fabric-gateway/package.json services/fabric-gateway/
COPY services/algorand-executor/package.json services/algorand-executor/
RUN pnpm install --frozen-lockfile --filter @optiwork/algorand-executor
COPY services/algorand-executor services/algorand-executor
RUN pnpm --filter @optiwork/algorand-executor build \
 && pnpm deploy --legacy --filter @optiwork/algorand-executor --prod /app

FROM node:24.19.0-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /app ./
COPY --from=build --chown=node:node /workspace/services/algorand-executor/dist ./dist
COPY --from=build --chown=node:node /workspace/services/algorand-executor/migrations ./migrations
USER node
EXPOSE 4301
CMD ["node", "dist/server.js"]
