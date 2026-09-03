#!/bin/sh
set -e
PORT="${PORT:-8080}"
sed -i "s/listen 8080/listen ${PORT}/" /etc/nginx/conf.d/default.conf
if [ -n "${API_UPSTREAM:-}" ]; then
  sed -i "s|proxy_pass http://127.0.0.1:8090;|proxy_pass ${API_UPSTREAM%/};|" /etc/nginx/conf.d/default.conf
fi
exec nginx -g "daemon off;"
