FROM node:20-slim AS build
WORKDIR /app
# the lockfile keeps the image build reproducible: dockerode's dependency tree
# moved to native modules (cpu-features via ssh2) and silently broke the bundle
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:20-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/dist ./dist
COPY public ./public
EXPOSE 8000
CMD ["node", "dist/index.js"]
