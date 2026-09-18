#!/usr/bin/env python3
"""Рисует html/icon-180.png — значок приложения для кошельков TON.

    python3 tools/make-icon.py

TON Connect показывает его в окне подтверждения перевода и требует именно
PNG: SVG понимают не все кошельки. Рисунок тот же, что в шапке приложения —
квадрат в квадрате, — и собирается кодом, чтобы не держать в репозитории
картинку, происхождение которой через полгода никто не вспомнит.
"""
import os
import struct
import zlib

SIZE = 180
BG = (0x01, 0x03, 0x0A)
LINE = (0x2E, 0x9B, 0xFF)
GLOW = (0x10, 0x22, 0x3C)
OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "html", "icon-180.png")


def rounded(x: int, y: int, a: int, b: int, r: int) -> bool:
    """Точка внутри скруглённого квадрата от a до b."""
    if not (a <= x <= b and a <= y <= b):
        return False
    cx = min(max(x, a + r), b - r)
    cy = min(max(y, a + r), b - r)
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r


def main() -> None:
    rows = []
    for y in range(SIZE):
        row = bytearray([0])
        for x in range(SIZE):
            px = BG
            if rounded(x, y, 22, 157, 34) and not rounded(x, y, 30, 149, 28):
                px = LINE                      # внешняя рамка
            elif rounded(x, y, 30, 149, 28):
                px = GLOW                      # подсветка внутри рамки
            if rounded(x, y, 66, 113, 12):
                px = LINE                      # внутренний квадрат
            row += bytes(px)
        rows.append(bytes(row))
    raw = b"".join(rows)

    def chunk(tag: bytes, data: bytes) -> bytes:
        return (struct.pack(">I", len(data)) + tag + data
                + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))

    png = (b"\x89PNG\r\n\x1a\n"
           + chunk(b"IHDR", struct.pack(">IIBBBBB", SIZE, SIZE, 8, 2, 0, 0, 0))
           + chunk(b"IDAT", zlib.compress(raw, 9))
           + chunk(b"IEND", b""))
    with open(OUT, "wb") as f:
        f.write(png)
    print(f"{OUT}: {len(png)} байт, {SIZE}×{SIZE}")


if __name__ == "__main__":
    main()
