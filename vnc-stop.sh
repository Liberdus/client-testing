#!/usr/bin/env bash

##############################################################################
# Helper function to safely stop a service using a PID file
##############################################################################
stop_service() {
    local process_name="$1"
    local pid_file="$2"
    local log_file="$3"

    if [ -f "$pid_file" ]; then
        local pid
        pid=$(cat "$pid_file")

        echo "Stopping $process_name (PID: $pid)..."
        kill "$pid" 2>/dev/null || true
        rm -f "$pid_file"
    fi

    # Optionally remove the log file if you want to clean up fully:
    if [ -f "$log_file" ]; then
        rm -f "$log_file"
    fi
}

##############################################################################
# Stop x11vnc, fluxbox, Xvfb, etc.
##############################################################################

stop_service "x11vnc"  "./x11vnc.pid"  "./x11vnc.log"
stop_service "fluxbox" "./fluxbox.pid" "./fluxbox.log"
stop_service "Xvfb"    "./xvfb.pid"    "./xvfb.log"
