FROM node:24-bookworm-slim
WORKDIR /app
COPY --chown=1000:1000 policy.mjs proxy.mjs ./
USER node
EXPOSE 3128
CMD ["node", "proxy.mjs"]
