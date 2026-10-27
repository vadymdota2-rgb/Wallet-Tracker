#!/usr/bin/env python3
"""nginx для своего сервера (VPS) из nginx.conf контейнера Cloud Run.

    sudo python3 tools/vps_nginx.py wallet.example.com > /etc/nginx/sites-available/wallettracker

Конфиг один на оба случая, отличия — здесь, а не во второй копии, которая
разошлась бы с первой:

  - https на 443 с сертификатом Let's Encrypt (на Cloud Run TLS — у Google),
    а 80 — только перенаправление на https и проверка certbot;
  - адрес человека — $remote_addr. На Cloud Run его брали из конца
    X-Forwarded-For, потому что там $remote_addr — узел Google. На своём
    сервере человек приходит напрямую, и X-Forwarded-For пишет он сам:
    взять адрес оттуда — значит дать ему подделать адрес и обойти нормы;
  - кэш логотипов и свечей — на диске (/var/cache/nginx), а не в /tmp,
    который у Cloud Run в оперативной памяти;
  - страницы — прямо из папки html/ репозитория: git pull обновляет и их;
  - ключ для API — из /etc/whale-api.env (WHALE_API_KEY), как у start.sh.

Каждая замена обязана найти своё место ровно один раз: поменяется
nginx.conf — скрипт остановится с ошибкой, а не выдаст полуготовый конфиг.
"""
from __future__ import annotations

import argparse
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DOMAIN = re.compile(r"(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}")
KEY = re.compile(r"[A-Za-z0-9_\-.~+/=]{16,200}")


def _key(path: str) -> str:
    """WHALE_API_KEY из файла окружения службы API."""
    with open(path, encoding="utf-8") as f:
        for line in f:
            name, _, val = line.strip().partition("=")
            if name == "WHALE_API_KEY":
                val = val.strip().strip('"').strip("'")
                if not KEY.fullmatch(val):
                    sys.exit(f"{path}: WHALE_API_KEY пустой или со странными символами")
                return val
    sys.exit(f"{path}: нет WHALE_API_KEY")


def _once(conf: str, old: str, new: str) -> str:
    n = conf.count(old)
    if n != 1:
        sys.exit(f"nginx.conf: «{old[:60]}» найдено {n} раз, а нужно ровно 1 — обновите tools/vps_nginx.py")
    return conf.replace(old, new)


def build(conf: str, domain: str, key: str, html: str) -> str:
    """Конфиг для своего сервера из конфига Cloud Run."""
    conf = _once(conf, "proxy_cache_path /tmp/logocache", "proxy_cache_path /var/cache/nginx/wt-logos")
    conf = _once(conf, "proxy_cache_path /tmp/klcache", "proxy_cache_path /var/cache/nginx/wt-klines")
    # Адрес человека — тот, с которого он пришёл (см. начало файла).
    m = re.search(r"map \$http_x_forwarded_for \$client_ip \{.*?\n\}\n", conf, re.S)
    if not m:
        sys.exit("nginx.conf: нет map $http_x_forwarded_for $client_ip — обновите tools/vps_nginx.py")
    conf = conf.replace(m.group(0), "map $remote_addr $client_ip {\n    default $remote_addr;\n}\n")
    live = f"/etc/letsencrypt/live/{domain}"
    conf = _once(conf, "    listen 8080;\n    server_name _;\n", (
        # «listen … http2», а не «http2 on»: так понимают и nginx 1.22–1.24
        # из Debian 12 и Ubuntu 24.04 (новые пишут лишь предупреждение).
        # Только IPv4: где IPv6 выключен, «listen [::]» не даёт nginx встать.
        "    listen 443 ssl http2;\n"
        f"    server_name {domain};\n"
        f"    ssl_certificate {live}/fullchain.pem;\n    ssl_certificate_key {live}/privkey.pem;\n"
        "    ssl_protocols TLSv1.2 TLSv1.3;\n    ssl_session_cache shared:SSL:10m;\n"
        '    add_header Strict-Transport-Security "max-age=31536000" always;\n'))
    conf = _once(conf, "    root /usr/share/nginx/html;\n", f"    root {html};\n")
    if "__API_KEY__" not in conf:
        sys.exit("nginx.conf: нет __API_KEY__ — обновите tools/vps_nginx.py")
    conf = conf.replace("__API_KEY__", key)
    # 80 — только certbot и перенаправление на https.
    return conf + (
        "\nserver {\n    listen 80;\n"
        f"    server_name {domain};\n    server_tokens off;\n"
        "    location /.well-known/acme-challenge/ { root /var/www/certbot; }\n"
        "    location / { return 301 https://$host$request_uri; }\n}\n")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("domain", help="домен мини-аппа, например wallet.example.com")
    ap.add_argument("--env", default="/etc/whale-api.env", help="файл с WHALE_API_KEY")
    ap.add_argument("--html", default=os.path.join(ROOT, "html"), help="папка со страницами")
    a = ap.parse_args()
    domain = a.domain.strip().lower()
    if not DOMAIN.fullmatch(domain):
        sys.exit(f"не похоже на домен: {a.domain}")
    with open(os.path.join(ROOT, "nginx.conf"), encoding="utf-8") as f:
        sys.stdout.write(build(f.read(), domain, _key(a.env), os.path.abspath(a.html)))


if __name__ == "__main__":
    main()
