# OptiWork API image.
#
# The build stage compiles the workspace; the runtime stage carries only the
# production dependencies and runs as an unprivileged user. No secret is baked
# into either layer: every credential arrives through the environment.
FROM node:24-bookworm-slim AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable
WORKDIR /workspace

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml turbo.json tsconfig.base.json ./
COPY packages/contracts/package.json packages/contracts/
COPY packages/domain/package.json packages/domain/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY services/algorand-executor/package.json services/algorand-executor/
RUN pnpm install --frozen-lockfile

COPY packages packages
COPY apps/api apps/api
RUN pnpm --filter @optiwork/contracts --filter @optiwork/domain --filter @optiwork/api build \
 && pnpm deploy --legacy --filter @optiwork/api --prod /app

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app ./
COPY --from=build /workspace/apps/api/migrations ./migrations
RUN mkdir -p /var/lib/optiwork && chown -R node:node /app /var/lib/optiwork
USER node
EXPOSE 4000
CMD ["node", "dist/server.js"]
