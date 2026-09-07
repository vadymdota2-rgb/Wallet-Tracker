#!/usr/bin/env python3
"""Собирает src/i18n/*.ts из словарей бота WhaleScanner.

    python3 tools/sync-i18n.py ../WhaleScanner

Тексты мини-аппа и бота обязаны совпадать: человек приходит из чата и
должен встретить те же слова. Поэтому словари не пишутся руками, а
вынимаются из ru.cpp (en + ru) и translations.cpp (остальные 14).

Ключи, которых у бота нет — оболочка самого мини-аппа, — лежат рядом в
tools/i18n-extra.json и обязаны быть заполнены на всех шестнадцати языках:
скрипт проверяет это и падает, если язык пропущен.
"""
import json
import os
import re
import sys

LANGS = ["en", "ru", "uk", "vi", "ko", "zh", "ja", "es",
         "pt", "fr", "de", "tr", "hi", "id", "ar", "pl"]

NAMES = {
    "en": "English", "ru": "Русский", "uk": "Українська", "vi": "Tiếng Việt",
    "ko": "한국어", "zh": "中文", "ja": "日本語", "es": "Español",
    "pt": "Português", "fr": "Français", "de": "Deutsch", "tr": "Türkçe",
    "hi": "हिन्दी", "id": "Bahasa Indonesia", "ar": "العربية", "pl": "Polski",
}

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(os.path.dirname(HERE), "src", "i18n")
EXTRA = os.path.join(HERE, "i18n-extra.json")

# Бот шлёт HTML в Telegram. React рисует текстом — теги убираем, иначе
# пользователь увидит <b> буквально.
TAG = re.compile(r"</?(?:b|i|u|s|code|pre|a|tg-spoiler|blockquote)(?:\s[^>]*)?>")


def clean(s: str) -> str:
    s = TAG.sub("", s)
    return s.replace("&lt;", "<").replace("&gt;", ">").replace("&amp;", "&").strip("\n")


def literals(text: str) -> str:
    """Склеивает соседние строковые литералы C++ в одну строку."""
    parts = re.findall(r'"((?:[^"\\]|\\.)*)"', text)
    s = "".join(parts)
    return (s.replace('\\"', '"').replace("\\n", "\n").replace("\\t", "\t")
             .replace("\\u00A0", " ").replace("\\\\", "\\"))


def read_en_ru(bot_dir: str) -> tuple[dict, dict]:
    src = open(os.path.join(bot_dir, "ru.cpp"), encoding="utf-8").read()
    start = src.index("const std::unordered_map<std::string, Entry>& table()")
    body = src[start: src.index("\n}", src.index("{", start))]
    en, ru = {}, {}
    for m in re.finditer(r'\{"([a-z0-9_]+)",\s*\{((?:[^{}]|\\.)*?)\}\}', body, re.S):
        pair = re.findall(r'((?:"(?:[^"\\]|\\.)*"\s*)+)', m.group(2))
        if len(pair) < 2:
            continue
        en[m.group(1)] = literals(pair[0])
        ru[m.group(1)] = literals(pair[1])
    return en, ru


def read_rest(bot_dir: str) -> dict[str, dict]:
    src = open(os.path.join(bot_dir, "translations.cpp"), encoding="utf-8").read()
    out: dict[str, dict] = {}
    for m in re.finditer(r"const Table& table(\w+)\(\)", src):
        code = m.group(1).lower()
        nxt = src.find("const Table& table", m.end())
        body = src[m.end(): nxt if nxt > 0 else len(src)]
        out[code] = {
            mm.group(1): literals(mm.group(2))
            for mm in re.finditer(r'\{"([a-z0-9_]+)",\s*((?:"(?:[^"\\]|\\.)*"\s*)+)\}', body, re.S)
        }
    return out


def main() -> int:
    bot_dir = sys.argv[1] if len(sys.argv) > 1 else "../WhaleScanner"
    if not os.path.isfile(os.path.join(bot_dir, "ru.cpp")):
        print(f"не вижу исходников бота в {bot_dir}", file=sys.stderr)
        return 1

    en, ru = read_en_ru(bot_dir)
    tables = {"en": en, "ru": ru, **read_rest(bot_dir)}
    extra = json.load(open(EXTRA, encoding="utf-8"))

    missing = {k: sorted(set(LANGS) - set(v)) for k, v in extra.items() if set(LANGS) - set(v)}
    if missing:
        for key, langs in missing.items():
            print(f"{EXTRA}: у ключа {key} нет языков: {', '.join(langs)}", file=sys.stderr)
        return 1

    keys = sorted(set(en) | set(extra))
    for lang in LANGS:
        rows = {
            k: extra[k][lang] if k in extra else clean(tables.get(lang, {}).get(k) or en[k])
            for k in keys
        }
        head = (
            "/** Английский задаёт набор ключей: остальные словари обязаны ему\n"
            " *  соответствовать. Тексты синхронизированы с ботом WhaleScanner —\n"
            " *  мини-апп говорит теми же словами. Файл собран tools/sync-i18n.py. */"
            if lang == "en"
            else f"/** {NAMES[lang]} ({lang}). Собрано tools/sync-i18n.py из словарей бота. */"
        )
        body = [head]
        if lang == "en":
            body.append("\nexport const en = {")
        else:
            body.append('\nimport type { Dict } from "./types";\n')
            body.append(f"export const {lang}: Dict = {{")
        body += [f"  {k}: {json.dumps(rows[k], ensure_ascii=False)}," for k in keys]
        body.append("} as const;" if lang == "en" else "};")
        with open(os.path.join(OUT, f"{lang}.ts"), "w", encoding="utf-8") as f:
            f.write("\n".join(body) + "\n")

    print(f"{len(keys)} ключей × {len(LANGS)} языков "
          f"({len(en)} из бота, {len(extra)} своих)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
