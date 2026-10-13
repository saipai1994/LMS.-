# syntax=docker/dockerfile:1
FROM node:22-alpine AS build
WORKDIR /app
ARG API_URL=http://api:3001
ENV API_URL=$API_URL
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npx next build

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/.next ./.next
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/next.config.mjs ./next.config.mjs
USER node
EXPOSE 3000
CMD ["npx", "next", "start", "-p", "3000"]
