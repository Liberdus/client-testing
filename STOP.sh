#!/bin/bash

set -e

# Stop Shardus network
echo "Stopping Shardus network..."
cd server
shardus-network stop
rm -rf ./instances
cd ..

# Stop Liberdus proxy
if [ -f proxy.pid ]; then
    echo "Stopping proxy..."
    kill $(cat proxy.pid) || true
    rm proxy.pid
    rm proxy.log
fi

# Stop web client server
if [ -f http.pid ]; then
    echo "Stopping web client server..."
    kill $(cat http.pid) || true
    rm http.pid
    rm http.log
fi

echo "All services stopped"