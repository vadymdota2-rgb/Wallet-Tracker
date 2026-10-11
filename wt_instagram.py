"""Автопубликация дайджеста в Instagram — каруселью, через Instagram API.

Instagram берёт картинки не файлом, а по ссылке: сам скачивает их с нашего
сервера. Поэтому порядок такой:

  1. страницы альбома (PNG) → JPEG: другого формата Instagram не принимает;
  2. JPEG кладутся во временное хранилище в памяти API под случайным именем
     и отдаются по адресу https://<WHALE_PUBLIC_URL>/api/ig/<имя>.jpg — час,
     потом исчезают; угадать имя нельзя;
  3. на каждую картинку — контейнер карусели, затем контейнер самой карусели
     с подписью, ждём, пока Instagram их обработает, и публикуем.

Токен «Instagram API с входом через Instagram» живёт 60 дней; продлеваем его
раз в неделю, а продлённый храним в базе — env-файл у сервиса только для
чтения. Новый токен в /etc/whale-api.env (другой, чем был) — главнее
продлённого: значит, человек выдал его заново.

Только стандартная библиотека и Pillow (уже стоит ради картинок дайджеста).
"""
from __future__ import annotations

import io
import json
import secrets
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

API = "https://graph.instagram.com"
VER = "v23.0"
# Сколько живёт ссылка на картинку: Instagram скачивает её за секунды, час —
# с запасом на его очередь.
FILE_TTL = 3600
# Сколько ждать, пока Instagram обработает контейнер.
WAIT_FOR = 120
# Продлевать токен раз в неделю (живёт 60 дней, продлить можно через сутки
# после выдачи) и, если не вышло, пробовать снова через шесть часов.
REFRESH_EVERY = 7 * 86400
REFRESH_RETRY = 6 * 3600
# Не больше десяти картинок в карусели (у нас пять).
MAX_ITEMS = 10
CAPTION_MAX = 2200
HASHTAGS = ("#bitcoin #crypto #btc #ethereum #eth #cryptonews #cryptomarket #cryptotrading "
            "#bitcoinnews #altcoins #defi #blockchain #trading #whales #marketupdate")


class IgError(Exception):
    pass


# --- Временное хранилище картинок -------------------------------------------

_files: dict[str, tuple[float, bytes]] = {}
_files_lock = threading.Lock()


def put_file(data: bytes) -> str:
    """Положить JPEG на час; вернуть имя файла для адреса /api/ig/<имя>."""
    name = secrets.token_hex(16) + ".jpg"
    now = time.time()
    with _files_lock:
        for k in [k for k, (t, _) in _files.items() if t < now]:
            _files.pop(k, None)
        _files[name] = (now + FILE_TTL, data)
    return name


def get_file(name: str) -> bytes | None:
    with _files_lock:
        got = _files.get(name)
    if not got or got[0] < time.time():
        return None
    return got[1]


def drop_files(names: list[str]) -> None:
    with _files_lock:
        for n in names:
            _files.pop(n, None)


def to_jpeg(png: bytes) -> bytes:
    """PNG → JPEG: Instagram принимает только JPEG."""
    from PIL import Image

    im = Image.open(io.BytesIO(png)).convert("RGB")
    out = io.BytesIO()
    im.save(out, "JPEG", quality=92, optimize=True)
    return out.getvalue()


# --- Instagram API ------------------------------------------------------------

def _call(method: str, path: str, params: dict, timeout: int = 60) -> dict:
    url = f"{API}/{path.lstrip('/')}" if path.startswith("refresh_access_token") else f"{API}/{VER}/{path.lstrip('/')}"
    body = urllib.parse.urlencode(params).encode()
    if method == "GET":
        req = urllib.request.Request(f"{url}?{body.decode()}")
    else:
        req = urllib.request.Request(url, data=body, method="POST",
                                     headers={"Content-Type": "application/x-www-form-urlencoded"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            out = json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        try:
            out = json.loads(e.read().decode())
        except (ValueError, OSError):
            raise IgError(f"HTTP {e.code}") from None
    except (urllib.error.URLError, TimeoutError, OSError, ValueError) as e:
        raise IgError(str(e)) from None
    if not isinstance(out, dict):
        raise IgError("bad reply")
    if out.get("error"):
        err = out["error"]
        # Сообщение Instagram — в журнал, но без токена, если он туда попал.
        msg = str(err.get("message") or err)[:300]
        raise IgError(f"{err.get('code', '?')}: {msg}")
    return out


def me(token: str) -> tuple[str, str]:
    """ID и имя профиля, к которому выдан токен."""
    out = _call("GET", "me", {"fields": "user_id,username", "access_token": token})
    uid = str(out.get("user_id") or out.get("id") or "")
    if not uid:
        raise IgError("no user_id")
    return uid, str(out.get("username") or "")


def refresh(token: str) -> tuple[str, int]:
    """Продлить токен ещё на 60 дней. Вернёт новый токен и срок в секундах."""
    out = _call("GET", "refresh_access_token", {"grant_type": "ig_refresh_token", "access_token": token})
    new = str(out.get("access_token") or "")
    if not new:
        raise IgError("no access_token")
    return new, int(out.get("expires_in") or 0)


def _wait(cid: str, token: str) -> None:
    """Ждать, пока контейнер обработается: FINISHED — можно дальше."""
    end = time.time() + WAIT_FOR
    while True:
        st = str(_call("GET", cid, {"fields": "status_code", "access_token": token}).get("status_code") or "")
        if st in ("FINISHED", "PUBLISHED"):
            return
        if st in ("ERROR", "EXPIRED"):
            raise IgError(f"container {st}")
        if time.time() > end:
            raise IgError("container timeout")
        time.sleep(3)


def posted(uid: str, token: str, marker: str) -> str:
    """Уже вышел пост с этой первой строкой подписи? Вернёт его ID.

    Защита от двойного поста: если прошлая попытка опубликовала, но ответ
    до нас не дошёл, повтор увидит пост и не выложит второй."""
    out = _call("GET", f"{uid}/media", {"fields": "id,caption,timestamp", "limit": 10, "access_token": token})
    for m in out.get("data") or []:
        cap = str(m.get("caption") or "")
        if marker and cap.startswith(marker):
            return str(m.get("id") or "")
    return ""


def publish(uid: str, token: str, urls: list[str], caption: str) -> str:
    """Опубликовать картинки (одну или каруселью) с подписью. Вернёт ID поста."""
    urls = urls[:MAX_ITEMS]
    if not urls:
        raise IgError("no images")
    if len(urls) == 1:
        cid = str(_call("POST", f"{uid}/media", {"image_url": urls[0], "caption": caption,
                                                 "access_token": token}).get("id") or "")
    else:
        kids = []
        for u in urls:
            kid = str(_call("POST", f"{uid}/media", {"image_url": u, "is_carousel_item": "true",
                                                     "access_token": token}).get("id") or "")
            if not kid:
                raise IgError("no child id")
            kids.append(kid)
        for kid in kids:
            _wait(kid, token)
        cid = str(_call("POST", f"{uid}/media", {"media_type": "CAROUSEL", "children": ",".join(kids),
                                                 "caption": caption, "access_token": token}).get("id") or "")
    if not cid:
        raise IgError("no container id")
    _wait(cid, token)
    mid = str(_call("POST", f"{uid}/media_publish", {"creation_id": cid, "access_token": token},
                    timeout=120).get("id") or "")
    if not mid:
        raise IgError("no media id")
    return mid


def ig_caption(text: str, foot: str) -> str:
    """Подпись для Instagram: выпуск, строка «где нас найти» и хэштеги.

    Ссылки в подписи Instagram не кликаются — поэтому имя бота и «ссылка в
    профиле», а не адрес."""
    tail = f"\n\n{foot}\n\n{HASHTAGS}"
    room = CAPTION_MAX - len(tail)
    if len(text) > room:
        text = text[:room].rsplit("\n", 1)[0]
    return text + tail


def log(msg: str) -> None:
    sys.stderr.write(f"[instagram] {msg}\n")
