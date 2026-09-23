# syntax=docker/dockerfile:1

FROM node:22-alpine AS deps
WORKDIR /app
ARG NPM_TOKEN
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:22-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build --chown=node:node /app ./
EXPOSE 3000
USER node
CMD ["node", "src/server.js"]
