#!/bin/sh
set -eu

# Internal only: nginx is the sole public entry point. The standard nginx
# entrypoint will subsequently exec nginx in the foreground.
/usr/local/bin/nh-goodreads >>/var/log/nh-goodreads.log 2>&1 &

