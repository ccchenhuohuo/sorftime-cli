FROM node:24-alpine AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json eslint.config.js ./
COPY src ./src
RUN pnpm build

FROM node:24-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --prod --frozen-lockfile
COPY --from=build /app/dist ./dist
USER node
# Operator CLI image. Supply the Account-SK at run time, never bake it into a layer:
#   docker run --rm -e SORFTIME_ACCOUNT_SK=... sorftime-cli category best-sellers --node-id 123
ENTRYPOINT ["node", "dist/cli.js"]
CMD ["--help"]
