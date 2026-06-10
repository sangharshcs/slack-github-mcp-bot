FROM node:20-alpine AS base

WORKDIR /app

RUN corepack enable

COPY package.json yarn.lock .yarnrc.yml ./
COPY .yarn/releases .yarn/releases

FROM base AS deps-prod

ENV NODE_ENV=production
RUN yarn install --immutable

FROM base AS deps-dev

RUN yarn install --immutable

FROM node:20-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production

# No ports exposed — Slack Socket Mode uses outbound HTTPS only

COPY --from=deps-prod /app/node_modules ./node_modules
COPY package.json index.js ./

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD kill -0 1 || exit 1

USER node

ENTRYPOINT ["node", "index.js"]

FROM base AS dev

COPY --from=deps-dev /app/node_modules ./node_modules

CMD ["yarn", "dev"]
