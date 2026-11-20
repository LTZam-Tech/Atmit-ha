# Atimtha execution agent (ADR-0014/0015): runs web and API tests where the applications are, and only ever calls
# out to the platform. Build from the repository root:
#   docker build -f agent/Dockerfile -t atimtha/agent:dev .
# Run:
#   docker run -e ATIMTHA_PLATFORM_URL=https://atimtha.client.local -e ATIMTHA_AGENT_TOKEN=atk_… atimtha/agent:dev
# Optional: ATIMTHA_JOB_KEY (pinned signing key, PEM), ATIMTHA_AGENT_ENGINES (web,api), ATIMTHA_EVIDENCE (failed|all|off),
#           ATIMTHA_AGENT_SLOTS (jobs at the same time, 1-8),
#           secrets the jobs reference: vault:env/NAME → environment variable NAME; vault:file/name → /run/secrets/name.
# The Playwright image carries the browsers matching @playwright/test in package.json.
FROM mcr.microsoft.com/playwright:v1.63.0-noble
WORKDIR /atimtha
# optional performance engine: docker build --build-arg K6_VERSION=v1.4.2 … (and ATIMTHA_AGENT_ENGINES=web,api,performance)
ARG K6_VERSION=
RUN if [ -n "$K6_VERSION" ]; then \
      curl -fsSL "https://github.com/grafana/k6/releases/download/${K6_VERSION}/k6-${K6_VERSION}-linux-amd64.tar.gz" | tar -xz -C /tmp \
      && mv "/tmp/k6-${K6_VERSION}-linux-amd64/k6" /usr/local/bin/k6 && rm -rf /tmp/k6-*; \
    fi
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts && npm cache clean --force
COPY tsconfig.json playwright.config.ts ./
COPY src ./src
COPY tests ./tests
COPY reporters ./reporters
COPY agent ./agent
COPY branding ./branding
# jobs are written to apps/job-<id>/ and removed after the run; the agent runs as the image's non-root user
RUN mkdir -p apps reports .auth && chown -R pwuser:pwuser /atimtha
USER pwuser
ENV CI=true NODE_ENV=production
CMD ["npx", "tsx", "agent/agent.ts"]
