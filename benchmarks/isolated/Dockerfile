FROM node:24-bookworm-slim
ARG CODEX_VERSION=0.155.1
RUN npm install --global --ignore-scripts @openai/codex@${CODEX_VERSION} \
    && npm cache clean --force \
    && mkdir -p /opt/runner /input /workspace /home/agent
COPY package.json package-lock.json /opt/runner/
RUN npm ci --prefix /opt/runner --ignore-scripts --omit=dev && npm cache clean --force
COPY *.ts /opt/runner/
WORKDIR /workspace
ENV LANG=C.UTF-8 TZ=UTC
ENTRYPOINT ["node", "/opt/runner/worker.ts"]
