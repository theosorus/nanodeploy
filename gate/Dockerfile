FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json build.mjs ./
COPY src ./src
COPY public ./public
RUN npm run build

# gate answers strangers on the internet: no shell tricks, no root, just node
FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/dist ./dist
COPY --from=build /app/public ./public
USER node
EXPOSE 4000
CMD ["node", "dist/index.js"]
