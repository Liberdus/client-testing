#!/bin/bash
set -e

# Update and install system dependencies (idempotent by nature)
sudo apt-get update
sudo apt-get install -y pkg-config jq

# Clone or update repositories
repos=(
  "https://github.com/Liberdus/server.git"
  "https://github.com/shardus/tools-cli-shardus-network.git"
  "https://github.com/Liberdus/web-client-v2.git"
  "https://github.com/Liberdus/liberdus-proxy.git"
)

for repo in "${repos[@]}"; do
  dir=$(basename "$repo" .git)
  if [ -d "$dir" ]; then
    echo "Updating $dir..."
    cd "$dir"
    git pull
    cd ..
  else
    echo "Cloning $dir..."
    git clone "$repo"
  fi
done

# Install npm dependencies (idempotent by nature but re-run after updates)
cd server && npm install && cd ..
cd tools-cli-shardus-network && npm install && npm link && cd ..

# Configure proxy settings (force desired state)
echo "🔧 Configuring proxy..."
cd liberdus-proxy
echo '[{"publicKey":"758b1c119412298802cd28dbfa394cdfeecc4074492d60844cc192d632d84de3","port":4000,"ip":"127.0.0.1"}]' > src/archiver_seed.json
jq '.standalone_network.enabled = false' src/config.json > tmp.json && mv tmp.json src/config.json
cd ..

# Configure web client (force desired state)
echo "🖥️  Configuring web client..."
sed -i 's/"port": [0-9]\+/"port": 3030/' web-client-v2/network.js

echo "✅ Setup completed successfully."