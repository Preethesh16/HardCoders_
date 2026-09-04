FROM node:24.19.0-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

COPY --chown=node:node apps/marketing ./apps/marketing

USER node
EXPOSE 4175
CMD ["node", "apps/marketing/serve.mjs"]
