#!/usr/bin/env bash
# Автовыкат на своём сервере: раз в минуту (wt-autodeploy.timer) смотрит,
# нет ли в GitHub новых коммитов, и выкатывает их — как раньше Cloud Run
# выкатывал приложение после каждого push.
#
#   WalletTracker  страницы nginx отдаёт прямо из html/ — им хватает git pull.
#                  Изменился сервер (*.py в корне) — проверка синтаксиса и
#                  перезапуск whale-api. Изменились nginx.conf или
#                  tools/vps_nginx.py — новый конфиг nginx, nginx -t, reload.
#   WhaleScanner   изменился код бота — сборка в whale_bot.new, подмена и
#                  перезапуск whalescanner.
#
# Сломанный выкат откатывается сам: не прошла проверка синтаксиса, не
# собрался бот, служба не поднялась после перезапуска — код возвращается к
# прежнему коммиту, служба — к прежней версии. Такой коммит запоминается
# (/var/lib/wt-autodeploy) и больше не выкатывается: иначе раз в минуту
# повторялись бы и выкат, и откат. Следующий коммит выкатывается как обычно.
#
# Работает от root — перезапуск служб. Но git, сборка и всё, что пришло из
# репозитория, — от владельца папок: код из GitHub с правами root не
# исполняется. По той же причине сам этот файл ставится копией в
# /usr/local/sbin (tools/autodeploy-install.sh) и push его не подменит.
set -uo pipefail

USER_NAME=${WT_USER:-vadymdota2}
ROOT_DIR=${WT_HOME:-/home/$USER_NAME}
WT=$ROOT_DIR/WalletTracker
WS=$ROOT_DIR/WhaleScanner
DOMAIN=${WT_DOMAIN:-}
STATE=${WT_STATE:-/var/lib/wt-autodeploy}
NGINX_SITE=${WT_NGINX_SITE:-/etc/nginx/sites-available/wallettracker}
API_ENV=${WT_API_ENV:-/etc/whale-api.env}
# Сколько ждать после перезапуска, прежде чем решить, что служба поднялась:
# упавшая при запуске за это время уже успевает упасть.
SETTLE=${WT_SETTLE:-8}

# HOME — свой: от root git искал бы настройки в /root и падал на правах.
as_user() { runuser -u "$USER_NAME" -- env HOME="$ROOT_DIR" "$@"; }
log() { echo "$*"; }

mkdir -p "$STATE"
exec 9>"$STATE/lock"
flock -n 9 || exit 0

OLD="" NEW="" CHANGED=""

# Перематывает папку на свежий коммит из GitHub. Успех — есть что выкатывать
# (OLD, NEW, CHANGED заполнены).
pull() {
    local dir=$1 name=$2 bad=""
    [ -d "$dir/.git" ] || return 1
    as_user git -C "$dir" fetch -q || { log "$name: git fetch не удался"; return 1; }
    OLD=$(as_user git -C "$dir" rev-parse HEAD) || return 1
    NEW=$(as_user git -C "$dir" rev-parse '@{u}') || { log "$name: у ветки нет связи с GitHub"; return 1; }
    [ "$OLD" = "$NEW" ] && return 1
    [ -f "$STATE/$name.bad" ] && bad=$(cat "$STATE/$name.bad")
    [ "$NEW" = "$bad" ] && return 1
    if ! as_user git -C "$dir" merge -q --ff-only '@{u}'; then
        log "$name: не перемотать на ${NEW:0:9} (на сервере свои правки?) — пропускаю"
        echo "$NEW" >"$STATE/$name.bad"
        return 1
    fi
    CHANGED=$(as_user git -C "$dir" diff --name-only "$OLD" "$NEW")
    log "$name: ${OLD:0:9} → ${NEW:0:9}"
    return 0
}

# Возврат к прежнему коммиту; сломанный запоминается, чтобы не повторять.
undo() {
    local dir=$1 name=$2 why=$3
    as_user git -C "$dir" reset -q --hard "$OLD"
    echo "$NEW" >"$STATE/$name.bad"
    log "$name: ${NEW:0:9} не выкачен — $why; вернул ${OLD:0:9}"
}

# Перезапуск и проверка, что служба осталась на ногах.
restart_ok() {
    systemctl restart "$1" || return 1
    sleep "$SETTLE"
    systemctl is-active --quiet "$1"
}

deploy_wt() {
    pull "$WT" wallettracker || return 0

    if grep -qE '^[^/]+\.py$' <<<"$CHANGED"; then
        if ! as_user python3 -m py_compile "$WT"/*.py; then
            undo "$WT" wallettracker "ошибка синтаксиса в сервере"
            return 0
        fi
        if ! restart_ok whale-api; then
            undo "$WT" wallettracker "whale-api не поднялся"
            systemctl restart whale-api
            return 0
        fi
        log "wallettracker: whale-api перезапущен"
    fi

    if [ -n "$DOMAIN" ] && grep -qxE 'nginx\.conf|tools/vps_nginx\.py' <<<"$CHANGED"; then
        local conf backup
        conf=$(mktemp) backup=$(mktemp)
        # Ключ API читает root и отдаёт трубой: файл с ключом скрипту из
        # репозитория недоступен, а /dev/stdin у трубы открывается заново.
        if cat "$API_ENV" | as_user python3 "$WT/tools/vps_nginx.py" "$DOMAIN" --env /dev/stdin >"$conf"; then
            cp "$NGINX_SITE" "$backup"
            cat "$conf" >"$NGINX_SITE"
            if nginx -t -q && systemctl reload nginx; then
                log "wallettracker: nginx обновлён"
            else
                cat "$backup" >"$NGINX_SITE"
                log "wallettracker: новый конфиг nginx не прошёл nginx -t — оставил прежний"
            fi
        else
            log "wallettracker: tools/vps_nginx.py не собрал конфиг — оставил прежний"
        fi
        rm -f "$conf" "$backup"
    fi
}

deploy_ws() {
    pull "$WS" whalescanner || return 0
    grep -qE '\.(cpp|h|hpp)$|^build\.sh$' <<<"$CHANGED" || return 0

    if ! as_user "$WS/build.sh" whale_bot.new >"$STATE/whalescanner.build.log" 2>&1; then
        tail -n 20 "$STATE/whalescanner.build.log"
        as_user rm -f "$WS/whale_bot.new"
        undo "$WS" whalescanner "бот не собрался"
        return 0
    fi
    as_user cp -f "$WS/whale_bot" "$WS/whale_bot.prev"
    as_user mv -f "$WS/whale_bot.new" "$WS/whale_bot"
    if ! restart_ok whalescanner; then
        as_user mv -f "$WS/whale_bot.prev" "$WS/whale_bot"
        undo "$WS" whalescanner "whalescanner не поднялся"
        systemctl restart whalescanner
        return 0
    fi
    log "whalescanner: бот пересобран и перезапущен"
}

deploy_wt
deploy_ws
