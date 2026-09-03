FROM node:24-bookworm-slim AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable
WORKDIR /workspace
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml turbo.json tsconfig.base.json ./
COPY packages/contracts/package.json packages/contracts/
COPY services/fabric-gateway/package.json services/fabric-gateway/
RUN pnpm install --frozen-lockfile
COPY packages/contracts packages/contracts
COPY services/fabric-gateway services/fabric-gateway
RUN pnpm --filter @optiwork/contracts --filter @optiwork/fabric-gateway build \
 && pnpm deploy --legacy --filter @optiwork/fabric-gateway --prod /app

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app ./
COPY --from=build /workspace/services/fabric-gateway/migrations ./migrations
USER node
EXPOSE 4200
CMD ["node", "dist/server.js"]
