#!/usr/bin/env python3
"""Собирает src/i18n/*.ts из tools/i18n.json.

    python3 tools/sync-i18n.py

Все тексты приложения живут в одном файле — tools/i18n.json: ключ, под ним
шестнадцать языков. Раньше часть словаря вынималась из исходников бота, но
меню в чате больше нет и бот хранит только тексты алертов, поэтому словарь
приложения теперь свой. Скрипт проверяет, что у каждого ключа заполнены все
шестнадцать языков, и падает, если язык пропущен.
"""
import json
import os
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
SRC = os.path.join(HERE, "i18n.json")


def main() -> int:
    table = json.load(open(SRC, encoding="utf-8"))

    missing = {k: sorted(set(LANGS) - set(v)) for k, v in table.items() if set(LANGS) - set(v)}
    if missing:
        for key, langs in missing.items():
            print(f"{SRC}: у ключа {key} нет языков: {', '.join(langs)}", file=sys.stderr)
        return 1

    keys = sorted(table)
    for lang in LANGS:
        rows = {k: table[k][lang] for k in keys}
        head = (
            "/** Английский задаёт набор ключей: остальные словари обязаны ему\n"
            " *  соответствовать. Файл собран tools/sync-i18n.py из tools/i18n.json. */"
            if lang == "en"
            else f"/** {NAMES[lang]} ({lang}). Собрано tools/sync-i18n.py из tools/i18n.json. */"
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

    print(f"{len(keys)} ключей × {len(LANGS)} языков")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
