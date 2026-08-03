# The Squad Hub service, for Azure Container Apps.
#
# Runs the control plane and serves the web app from the same container. There
# is no build step for the web app, so there is nothing to compile here.
FROM mcr.microsoft.com/devcontainers/javascript-node:20-bookworm AS base

WORKDIR /app
COPY package.json ./
COPY src ./src
COPY bin ./bin
COPY web ./web

ENV NODE_ENV=production
ENV PORT=7420
EXPOSE 7420

# Fail the container if the service stops answering, rather than leaving a dead
# control plane accepting connections.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||7420)+'/healthz',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "bin/squad-hub.js", "serve", "--port", "7420", "--host", "0.0.0.0"]
