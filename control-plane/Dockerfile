FROM node:20-slim AS build
WORKDIR /app
# The lockfile keeps the image reproducible. dockerode drags in ssh2, which
# compiles native bindings (cpu-features, sshcrypto) that esbuild cannot bundle;
# build.mjs marks every .node external. ssh2 wraps those requires in try/catch
# and we only ever speak tcp to the socket proxy, so they are never needed.
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json build.mjs ./
COPY src ./src
RUN npm run build

FROM node:20-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/dist ./dist
COPY public ./public
EXPOSE 8000
CMD ["node", "dist/index.js"]
