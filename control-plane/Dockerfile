FROM node:20-slim AS build
WORKDIR /app
# The lockfile keeps the image reproducible. dockerode drags in ssh2, which
# optionally loads the native cpu-features binding; esbuild cannot bundle a
# .node file, so the build marks it external. ssh2 wraps that require in a
# try/catch and we only ever speak tcp to the socket proxy, so it is never
# needed at runtime.
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
