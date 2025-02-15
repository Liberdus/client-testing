#!/bin/bash
set -e

# Update and install system dependencies
sudo apt-get update
sudo apt-get install -y pkg-config jq

# Clone repositories
git clone https://github.com/Liberdus/server.git
git clone https://github.com/shardus/tools-cli-shardus-network.git
git clone https://github.com/Liberdus/web-client-v2.git
git clone https://github.com/Liberdus/liberdus-proxy.git
# git clone https://github.com/Liberdus/web-client-v2-testing.git

# Install npm dependencies
cd server && npm install && cd ..
cd tools-cli-shardus-network && npm install && npm link && cd ..

# Configure proxy settings
echo "🔧 Configuring proxy..."
cd liberdus-proxy
echo '[{"publicKey":"758b1c119412298802cd28dbfa394cdfeecc4074492d60844cc192d632d84de3","port":4000,"ip":"127.0.0.1"}]' > src/archiver_seed.json
jq '.standalone_network.enabled = false' src/config.json > tmp.json && mv tmp.json src/config.json
cd ..

# Configure web client
echo "🖥️  Configuring web client..."
sed -i 's/"port": [0-9]\+/"port": 3030/' web-client-v2/network.js

echo "✅ Setup completed successfully."