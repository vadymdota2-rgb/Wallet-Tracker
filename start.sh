#!/bin/sh
set -e
PORT="${PORT:-8080}"
# Без адреса API всё уйдёт на localhost, где никого нет: пустые экраны
# и 502 в логах. Лучше не подняться с понятным сообщением.
: "${API_UPSTREAM:?не задан адрес API}"
case "$API_UPSTREAM" in
  http://*|https://*) ;;
  *) echo "API_UPSTREAM должен начинаться с http:// или https://" >&2; exit 1 ;;
esac
sed -i "s/listen 8080/listen ${PORT}/" /etc/nginx/conf.d/default.conf
sed -i "s|http://127.0.0.1:8090|${API_UPSTREAM%/}|g" /etc/nginx/conf.d/default.conf
exec nginx -g "daemon off;"
