FROM node:22-bookworm-slim
WORKDIR /app
COPY server.mjs ./server.mjs
ENV PORT=8545 UPSTREAM_RPC=https://rpc.testnet.arc.network MAX_TOPIC_OR=8
CMD ["node", "server.mjs"]
