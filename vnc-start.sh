#!/usr/bin/env bash

##############################################################################
# Idempotent environment setup (directories, permissions, VNC password, etc.)
##############################################################################

# Ensure /tmp/.X11-unix exists with proper permissions
if [ ! -d /tmp/.X11-unix ]; then
    mkdir -p /tmp/.X11-unix
fi
chmod 1777 /tmp/.X11-unix

# Ensure the vnc directory exists
if [ ! -d /home/pwuser/.vnc ]; then
    mkdir -p /home/pwuser/.vnc
fi

# Create/set VNC password file if it doesn't exist or is empty
if [ ! -s /home/pwuser/.vnc/passwd ]; then
    echo "password" | vncpasswd -f > /home/pwuser/.vnc/passwd
    chmod 600 /home/pwuser/.vnc/passwd
fi

# Ensure everything under /home/pwuser is owned by pwuser
chown -R pwuser:pwuser /home/pwuser

##############################################################################
# Force x11 environment (unset Wayland vars, etc.)
##############################################################################

unset WAYLAND_DISPLAY
export XDG_SESSION_TYPE=x11
export DISPLAY=:99

##############################################################################
# Helper function to safely start a process only if not running
##############################################################################
start_service() {
    local process_name="$1"
    local pid_file="$2"
    local start_cmd="$3"
    local log_file="$4"

    # Remove stale PID file if process not running
    if [ -f "$pid_file" ]; then
        if ! kill -0 "$(cat "$pid_file")" 2>/dev/null; then
            echo "Removing stale $process_name PID file."
            rm -f "$pid_file"
        fi
    fi

    # Check if process is running
    if pgrep -x "$process_name" >/dev/null; then
        echo "$process_name is already running."
    else
        echo "Starting $process_name..."
        # Truncate the log (>) so it's fresh each start; append (>>) if desired
        eval "$start_cmd" > "$log_file" 2>&1 &
        echo $! > "$pid_file"
    fi
}

##############################################################################
# Start services: Xvfb, Fluxbox, x11vnc
##############################################################################

start_service "Xvfb"    "./xvfb.pid" \
  "Xvfb :99 -screen 0 1920x1080x24 -ac +extension GLX +render -noreset" \
  "./xvfb.log"

start_service "fluxbox" "./fluxbox.pid" \
  "fluxbox" \
  "./fluxbox.log"

start_service "x11vnc"  "./x11vnc.pid" \
  "x11vnc -forever -usepw -display :99 -rfbport 5901 -noxdamage -shared -q" \
  "./x11vnc.log"

##############################################################################
# Print out the VNC password and port
##############################################################################
echo
echo "-----------------------------------------------------"
echo "VNC Password:  password"
echo "VNC Port:      5901"
echo "Display:       :99"
echo "-----------------------------------------------------"
