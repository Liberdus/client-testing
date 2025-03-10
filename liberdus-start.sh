#!/bin/bash

set -e

is_port_in_use() {
    local port="$1"
    lsof -i :"$port" >/dev/null 2>&1
}

# Start Shardus network (10 nodes)
if ! is_port_in_use 4000; then
    echo "Starting Shardus network..."
    cd server
    shardus-network start 10
    cd ..
    echo "Waiting for nodes to initialize..."
    sleep 5
else
    echo "Shardus network already running"
fi

# Start Liberdus proxy
if ! is_port_in_use 3030; then
    echo "Starting Liberdus proxy..."
    cd liberdus-proxy
    cargo run > ../proxy.log 2>&1 &
    echo $! > ../proxy.pid
    cd ..
    sleep 2
else
    echo "Liberdus proxy already running"
fi

# Start web client server
if ! is_port_in_use 8080; then
    echo "Starting web client server..."
    cd web-client-v2
    npx http-server > ../http.log 2>&1 &
    echo $! > ../http.pid
    cd ..
else
    echo "Web client server already running"
fi

echo "All services started"