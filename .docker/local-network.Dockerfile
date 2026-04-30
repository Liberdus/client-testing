FROM ubuntu:22.04

ARG NODE_VERSION=20.19.3
ARG SERVER_RUST_VERSION=1.82.0
ARG PROXY_RUST_VERSION=stable

ENV DEBIAN_FRONTEND=noninteractive
ENV PATH="/opt/node/bin:/root/.cargo/bin:${PATH}"
ENV LIBERDUS_SERVER_RUST_TOOLCHAIN="${SERVER_RUST_VERSION}"
ENV LIBERDUS_PROXY_RUST_TOOLCHAIN="${PROXY_RUST_VERSION}"

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    curl \
    git \
    jq \
    libssl-dev \
    lsof \
    build-essential \
    pkg-config \
    procps \
    python3 \
    rsync \
    xz-utils \
  && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" -o /tmp/node.tar.xz \
  && mkdir -p /opt/node \
  && tar -xJf /tmp/node.tar.xz -C /opt/node --strip-components=1 \
  && rm /tmp/node.tar.xz \
  && npm install -g http-server \
  && npm cache clean --force

RUN git config --global url."https://github.com/".insteadOf "ssh://git@github.com/" \
  && git config --global url."https://github.com/".insteadOf "git@github.com:"

RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
  | sh -s -- -y --default-toolchain "${SERVER_RUST_VERSION}" --profile minimal \
  && rustup toolchain install "${PROXY_RUST_VERSION}" --profile minimal

RUN npm install -g https://github.com/shardus/tools-cli-shardus-network.git \
  && npm cache clean --force

WORKDIR /workspace/client-testing

COPY scripts/local-network /usr/local/bin/liberdus-local-network
RUN chmod +x /usr/local/bin/liberdus-local-network/*.sh

CMD ["/usr/local/bin/liberdus-local-network/start.sh"]
