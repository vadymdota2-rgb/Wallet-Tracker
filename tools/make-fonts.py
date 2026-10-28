#!/usr/bin/env python3
"""Шрифт приложения — со своего сервера, а не с Google Fonts.

    pip install fonttools brotli && python3 tools/make-fonts.py

Раньше IBM Plex Sans брался с fonts.googleapis.com: при каждом открытии
приложения телефон отдавал Google свой IP-адрес без согласия человека, а это
нарушение RODO (суд Мюнхена, 3 O 17493/20, 2022). Теперь шрифт лежит рядом с
приложением: скрипт делает из fonts/*.ttf (те же файлы, что рисуют картинку
дайджеста) по два файла woff2 на насыщенность — латиница со всем остальным и
кириллица. Кириллица качается только там, где она есть на экране
(unicode-range в src/styles/fonts.css). Готовые файлы лежат в репозитории,
скрипт нужен только при смене шрифта.
"""
import os

from fontTools import subset

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WEIGHTS = ("Regular", "Medium", "SemiBold", "Bold")
# Совпадает с unicode-range в src/styles/fonts.css.
CYRILLIC = [*range(0x0400, 0x0530), 0x20B4, 0x2116]


def main() -> None:
    for w in WEIGHTS:
        src = os.path.join(ROOT, "fonts", f"IBMPlexSans-{w}.ttf")
        cmap = set(subset.load_font(src, subset.Options()).getBestCmap())
        parts = {"cyrillic": sorted(cmap & set(CYRILLIC)), "latin": sorted(cmap - set(CYRILLIC))}
        for name, cps in parts.items():
            opt = subset.Options()
            opt.flavor = "woff2"
            opt.layout_features = ["*"]
            opt.name_IDs = ["*"]  # авторские права и лицензия OFL остаются в файле
            opt.notdef_outline = True
            font = subset.load_font(src, opt)
            sub = subset.Subsetter(opt)
            sub.populate(unicodes=cps)
            sub.subset(font)
            out = os.path.join(ROOT, "src", "assets", "fonts", f"IBMPlexSans-{w}-{name}.woff2")
            subset.save_font(font, out, opt)
            print(out, os.path.getsize(out))


if __name__ == "__main__":
    main()
