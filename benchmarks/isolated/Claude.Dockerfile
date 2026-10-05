FROM node:24-bookworm-slim
ARG CLAUDE_CODE_VERSION=2.1.285
# Claude Code ships its native binary through platform-specific optional
# dependencies and links it in a postinstall step; do not skip either.
RUN npm install --global @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} \
    && npm cache clean --force \
    && mkdir -p /opt/runner /input /workspace /home/agent
COPY package.json package-lock.json /opt/runner/
RUN npm ci --prefix /opt/runner --ignore-scripts --omit=dev && npm cache clean --force
COPY *.ts /opt/runner/
WORKDIR /workspace
ENV LANG=C.UTF-8 TZ=UTC
ENTRYPOINT ["node", "/opt/runner/claude-worker.ts"]
