#!/usr/bin/env bash
# Включает автовыкат (tools/autodeploy.sh) на своём сервере:
#
#   sudo tools/autodeploy-install.sh wallettracker.pl
#
# Ставит копию скрипта в /usr/local/sbin/wt-autodeploy и таймер, который
# запускает её раз в минуту. Изменился tools/autodeploy.sh — запустить
# снова: копия сама не обновляется (иначе push в репозиторий менял бы код,
# который работает с правами root).
#
# Заодно ограничивает срок журнала системы: в нём строки служб с IP-адресом
# (бан защиты) и Telegram ID (отказ в пробе), а по умолчанию journald
# чистит только по размеру — записи жили бы месяцами. Политика
# конфиденциальности обещает 14 дней (RODO, ст. 5: хранить не дольше нужного);
# журналы nginx Debian и так держит 14 дней (logrotate).
set -euo pipefail

domain=${1:-}
if ! [[ $domain =~ ^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$ ]]; then
    echo "домен мини-аппа: sudo $0 wallettracker.pl" >&2
    exit 2
fi
[ "$(id -u)" = 0 ] || { echo "нужен sudo" >&2; exit 2; }

install -m 755 "$(dirname "$0")/autodeploy.sh" /usr/local/sbin/wt-autodeploy

cat >/etc/systemd/system/wt-autodeploy.service <<EOF
[Unit]
Description=Wallet Tracker: выкат новых коммитов из GitHub
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
Environment=WT_DOMAIN=$domain
ExecStart=/usr/local/sbin/wt-autodeploy
TimeoutStartSec=30min
EOF

cat >/etc/systemd/system/wt-autodeploy.timer <<'EOF'
[Unit]
Description=Wallet Tracker: проверка GitHub раз в минуту

[Timer]
# OnActiveSec — первый запуск сразу после включения: OnUnitInactiveSec
# отсчитывает от прошлого запуска, а его ещё не было.
OnActiveSec=10s
OnBootSec=2min
OnUnitInactiveSec=1min
AccuracySec=5s

[Install]
WantedBy=timers.target
EOF

mkdir -p /etc/systemd/journald.conf.d
cat >/etc/systemd/journald.conf.d/wt-retention.conf <<'EOF'
[Journal]
MaxRetentionSec=14day
EOF
systemctl restart systemd-journald

systemctl daemon-reload
systemctl enable --now wt-autodeploy.timer
echo "Автовыкат включён. Журнал: journalctl -u wt-autodeploy -f"
