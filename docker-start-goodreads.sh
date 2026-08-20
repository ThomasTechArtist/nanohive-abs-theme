#!/bin/sh
set -eu

# Internal only: nginx is the sole public entry point. The standard nginx
# entrypoint will subsequently exec nginx in the foreground.
# The nginx njs worker persists resolved ratings with an atomic temp-file
# rename.  Bind-mounted Synology files may otherwise retain the SMB user's
# ownership and be readable but not writable by nginx.
mkdir -p /data/nh
touch /data/nh/goodreads-ratings.json
chown nginx:nginx /data/nh /data/nh/goodreads-ratings.json
chmod 0775 /data/nh
chmod 0664 /data/nh/goodreads-ratings.json
/usr/local/bin/nh-goodreads >>/var/log/nh-goodreads.log 2>&1 &
