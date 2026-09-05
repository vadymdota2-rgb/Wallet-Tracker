#!/bin/sh
set -e
CONF=/etc/nginx/conf.d/default.conf
PORT="${PORT:-8080}"
sed -i "s/listen 8080/listen ${PORT}/" "$CONF"

if [ -n "${API_UPSTREAM:-}" ]; then
  sed -i "s|http://127.0.0.1:8090|${API_UPSTREAM%/}|g" "$CONF"
fi

# Секрет, которым nginx подписывает поход в API. Пусто — API поднимется без
# проверки ключа и будет доступен всем, кто знает адрес и порт.
if [ -n "${API_KEY:-}" ]; then
  sed -i "s|__API_KEY__|${API_KEY}|g" "$CONF"
else
  echo "start.sh: API_KEY не задан — прямой доступ к порту API ничем не закрыт" >&2
  sed -i "s|__API_KEY__||g" "$CONF"
fi

nginx -t
exec nginx -g "daemon off;"
