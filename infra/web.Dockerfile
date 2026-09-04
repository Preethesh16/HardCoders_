# OptiWork web image.
#
# Next.js standalone output keeps the runtime layer small. Only NEXT_PUBLIC_*
# values reach the browser bundle, and none of them is a secret.
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
RUN pnpm install --frozen-lockfile --filter @optiwork/web...

COPY packages packages
COPY apps/web apps/web
RUN pnpm --filter @optiwork/contracts build && pnpm --filter @optiwork/web build

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /workspace/apps/web/.next/standalone ./
COPY --from=build /workspace/apps/web/.next/static ./apps/web/.next/static
COPY --from=build /workspace/apps/web/public ./apps/web/public
USER node
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
