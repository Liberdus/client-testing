#!/bin/bash
# Start virtual display server in background
Xvfb :99 -screen 0 1920x1080x24 -ac +extension GLX +render -noreset >/dev/null 2>&1 &

# Start window manager in background
fluxbox >/dev/null 2>&1 &

# Start VNC server in foreground (blocks until terminated)
x11vnc -forever -usepw -display :99 -rfbport 5901 -noxdamage -shared -q