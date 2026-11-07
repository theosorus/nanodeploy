FROM node:24-bookworm-slim
WORKDIR /app
COPY policy.mjs proxy.mjs ./
USER node
EXPOSE 3128
CMD ["node", "proxy.mjs"]
