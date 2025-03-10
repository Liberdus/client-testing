FROM mcr.microsoft.com/playwright:v1.50.1-jammy

USER root
ENV DEBIAN_FRONTEND=noninteractive

# Install system dependencies (now includes tightvncserver and sudo)
RUN apt-get update && \
    apt-get install -y \
    curl \
    pkg-config \
    build-essential \
    libssl-dev \
    tightvncserver \
    xvfb \
    fluxbox \
    x11vnc \
    ca-certificates \
    bash-completion \
    sudo && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# Add pwuser to sudoers with passwordless access
RUN echo "pwuser ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/pwuser && \
    chmod 0440 /etc/sudoers.d/pwuser

# Switch to non-root user for runtime operations
USER pwuser
WORKDIR /home/pwuser

# Install Node.js using NVM
RUN curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash \
    && echo 'export NVM_DIR="$HOME/.nvm"' >> ~/.bashrc \
    && echo '[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"' >> ~/.bashrc \
    && export NVM_DIR="$HOME/.nvm" \
    && [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" \
    && nvm install 18.16.1 \
    && nvm alias default 18.16.1 \
    && nvm use default \
    && npm install -g npm@9.5.1 \
    && corepack enable

# Install Rust toolchain (specifically version 1.74.0)
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain 1.74.0 --profile minimal
ENV PATH="/home/pwuser/.cargo/bin:${PATH}"

# Set environment variables
ENV DISPLAY=:99 \
    NVM_DIR="/home/pwuser/.nvm" \
    PATH="/home/pwuser/.nvm/versions/node/v18.16.1/bin:$PATH" \
    PLAYWRIGHT_HTML_HOST="0.0.0.0"