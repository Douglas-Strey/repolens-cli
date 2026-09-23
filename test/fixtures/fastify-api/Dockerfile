FROM node:22-alpine

WORKDIR /app

RUN corepack enable

COPY package.json yarn.lock .yarnrc.yml ./
RUN yarn install --immutable

COPY . .
RUN yarn build

ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "dist/server.js"]
