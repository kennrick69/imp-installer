#!/usr/bin/env python3
"""
IMP Squad - gerador de icon.ico em Python puro (stdlib only).

Sem ImageMagick, sem Pillow. Rasteriza o ícone diretamente em buffer
RGBA, comprime em PNG (zlib + crc32 da stdlib) e empacota tudo num
.ico multi-tamanho (16, 32, 48, 64, 128, 256).

Conceito: escudo teal IMP com 3 barras (squad em formacao) e ponto
central (lider/JOs). Silhueta forte mesmo a 16px.
"""

import math
import os
import struct
import sys
import zlib

# Paleta (RGBA)
BG       = (14, 16, 21, 255)        # #0E1015 (fundo)
TEAL     = (13, 148, 136, 255)      # #0D9488 (escudo)
TEAL_HV  = (20, 184, 166, 255)      # #14B8A6 (borda)
DARK     = (7, 8, 11, 217)          # #07080B 85% (barras)
LIGHT    = (243, 244, 248, 255)     # #F3F4F8 (ponto central)
TRANSP   = (0, 0, 0, 0)

# Resolucao de referencia (depois reduz proporcionalmente)
REF = 256.0


def make_canvas(size):
    """Cria buffer RGBA size x size com fundo transparente."""
    return [TRANSP] * (size * size)


def blend(dst, src):
    """Alpha-blend src sobre dst (ambos RGBA tuplas 0-255)."""
    sa = src[3] / 255.0
    if sa <= 0:
        return dst
    if sa >= 1 and dst[3] == 0:
        return src
    da = dst[3] / 255.0
    out_a = sa + da * (1 - sa)
    if out_a <= 0:
        return TRANSP
    r = (src[0] * sa + dst[0] * da * (1 - sa)) / out_a
    g = (src[1] * sa + dst[1] * da * (1 - sa)) / out_a
    b = (src[2] * sa + dst[2] * da * (1 - sa)) / out_a
    return (int(r), int(g), int(b), int(out_a * 255))


def set_px(buf, size, x, y, color, coverage=1.0):
    """Pinta pixel com cobertura (0-1) - antialiasing."""
    if x < 0 or y < 0 or x >= size or y >= size:
        return
    if coverage <= 0:
        return
    c = (color[0], color[1], color[2], int(color[3] * coverage))
    idx = y * size + x
    buf[idx] = blend(buf[idx], c)


def fill_rounded_rect(buf, size, x0, y0, x1, y1, r, color):
    """Retangulo arredondado com antialiasing nas curvas."""
    for y in range(max(0, int(y0) - 1), min(size, int(y1) + 2)):
        for x in range(max(0, int(x0) - 1), min(size, int(x1) + 2)):
            # Distancia aos cantos
            cx, cy = None, None
            if x < x0 + r and y < y0 + r:
                cx, cy = x0 + r, y0 + r
            elif x > x1 - r and y < y0 + r:
                cx, cy = x1 - r, y0 + r
            elif x < x0 + r and y > y1 - r:
                cx, cy = x0 + r, y1 - r
            elif x > x1 - r and y > y1 - r:
                cx, cy = x1 - r, y1 - r

            if cx is not None:
                # Dentro de um quadrante de canto: distancia ao centro do raio
                dx = x + 0.5 - cx
                dy = y + 0.5 - cy
                d = math.sqrt(dx * dx + dy * dy)
                cov = max(0.0, min(1.0, r - d + 0.5))
                set_px(buf, size, x, y, color, cov)
            else:
                # Corpo do retangulo
                if x0 <= x < x1 and y0 <= y < y1:
                    set_px(buf, size, x, y, color, 1.0)
                else:
                    # Bordas retas
                    cov_x = 1.0
                    cov_y = 1.0
                    if x < x0:
                        cov_x = max(0.0, x + 1 - x0)
                    elif x >= x1:
                        cov_x = max(0.0, x1 - x)
                    if y < y0:
                        cov_y = max(0.0, y + 1 - y0)
                    elif y >= y1:
                        cov_y = max(0.0, y1 - y)
                    cov = cov_x * cov_y
                    if cov > 0:
                        set_px(buf, size, x, y, color, cov)


def fill_circle(buf, size, cx, cy, r, color):
    """Circulo cheio com antialiasing."""
    x0 = max(0, int(cx - r - 1))
    x1 = min(size, int(cx + r + 2))
    y0 = max(0, int(cy - r - 1))
    y1 = min(size, int(cy + r + 2))
    for y in range(y0, y1):
        for x in range(x0, x1):
            dx = x + 0.5 - cx
            dy = y + 0.5 - cy
            d = math.sqrt(dx * dx + dy * dy)
            cov = max(0.0, min(1.0, r - d + 0.5))
            if cov > 0:
                set_px(buf, size, x, y, color, cov)


def point_in_shield(x, y, size):
    """
    Define se (x, y) esta dentro do escudo (em coordenadas do canvas
    de tamanho 'size'). O escudo eh definido em coords de referencia
    REF=256 e escalado.

    Topo: trapezio de y=36 ate y=64 com base superior estreitando.
    Corpo: retangulo de y=64 ate y=132.
    Base: arco que afina ate ponta em (128, 224).
    """
    s = size / REF
    # Coordenadas em espaco de referencia
    rx = x / s
    ry = y / s

    # Topo (y de 36 a 64): linhas (48,64)-(128,36) e (208,64)-(128,36)
    if ry < 36:
        return False
    if ry < 64:
        # esquerda: x cresce de 128 (em y=36) ate 48 (em y=64)
        # parametricamente: t = (64-ry)/(64-36) vai de 1 -> 0
        t = (64 - ry) / 28.0
        left = 48 + (128 - 48) * t
        right = 208 - (208 - 128) * t
        return left <= rx <= right

    # Corpo retangular de y=64 a y=132
    if ry <= 132:
        return 48 <= rx <= 208

    # Base afilada de y=132 a y=224, ponta em (128, 224)
    if ry <= 224:
        # Curva quadratica simples: largura diminui de 160 (em 132) a 0 (em 224)
        # com easing pra parecer arco organico
        t = (ry - 132) / (224 - 132)  # 0..1
        # easing: x^1.4 -> curva mais cheia no topo, afila no fim
        e = t ** 1.4
        half_w = 80 * (1 - e)
        return abs(rx - 128) <= half_w

    return False


def stroke_shield(x, y, size, thickness=4):
    """Borda do escudo (anel de 'thickness' px em REF)."""
    s = size / REF
    rx = x / s
    ry = y / s
    inside = point_in_shield(x, y, size)
    if not inside:
        return False
    # Esta dentro: checa se algum vizinho a 'thickness' px FOR esta fora
    th = thickness
    for dx in (-th, th, 0):
        for dy in (-th, th, 0):
            if dx == 0 and dy == 0:
                continue
            nrx = rx + dx
            nry = ry + dy
            # converte de volta pra coord de canvas
            nx = nrx * s
            ny = nry * s
            if not point_in_shield(nx, ny, size):
                return True
    return False


def draw_icon(size):
    """Desenha o icon em 'size' x 'size' e retorna buffer RGBA flat."""
    buf = make_canvas(size)
    s = size / REF

    # 1) Fundo arredondado escuro
    radius_bg = 48 * s
    fill_rounded_rect(buf, size, 0, 0, size, size, radius_bg, BG)

    # 2) Escudo teal preenchido + borda
    for y in range(size):
        for x in range(size):
            if point_in_shield(x, y, size):
                idx = y * size + x
                buf[idx] = blend(buf[idx], TEAL)

    # 3) Borda do escudo (so se size >= 32 - em 16 fica empapado)
    if size >= 32:
        for y in range(size):
            for x in range(size):
                if stroke_shield(x, y, size, thickness=3):
                    idx = y * size + x
                    buf[idx] = blend(buf[idx], TEAL_HV)

    # 4) Tres barras verticais (squad em formacao)
    # Em REF: bar1 (82,92)-(100,168), bar2 (119,80)-(137,180), bar3 (156,92)-(174,168)
    bar_r = 4 * s
    # Em tamanhos pequenos, simplifica: barras mais grossas/menos detalhe
    if size >= 48:
        bars = [
            (82, 92, 100, 168),
            (119, 80, 137, 180),
            (156, 92, 174, 168),
        ]
    elif size >= 24:
        # 16-32: barras mais grossas e simples
        bars = [
            (78, 92, 104, 168),
            (115, 80, 141, 180),
            (152, 92, 178, 168),
        ]
    else:
        # 16px: so a barra central (silhueta minima)
        bars = [
            (115, 80, 141, 180),
        ]

    for (bx0, by0, bx1, by1) in bars:
        fill_rounded_rect(
            buf, size,
            bx0 * s, by0 * s, bx1 * s, by1 * s,
            bar_r, DARK
        )

    # 5) Ponto central (lider/JOs) — so visivel em >= 32px
    if size >= 32:
        fill_circle(buf, size, 128 * s, 60 * s, 10 * s, LIGHT)

    return buf


# ════════════════════════════════════════════════════════════
# PNG ENCODER (puro Python via zlib + crc32 da stdlib)
# ════════════════════════════════════════════════════════════

def write_png(buf, size):
    """Encoda buffer RGBA flat em bytes PNG."""
    sig = b"\x89PNG\r\n\x1a\n"

    def chunk(tag, data):
        return (struct.pack(">I", len(data)) + tag + data
                + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))

    # IHDR: width, height, bit depth=8, color type=6 (RGBA), 0,0,0
    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)

    # IDAT: scanlines com filter byte = 0 prefix
    raw = bytearray()
    for y in range(size):
        raw.append(0)  # filter: None
        for x in range(size):
            r, g, b, a = buf[y * size + x]
            raw += bytes((r, g, b, a))
    idat = zlib.compress(bytes(raw), 9)

    iend = b""

    return sig + chunk(b"IHDR", ihdr) + chunk(b"IDAT", idat) + chunk(b"IEND", iend)


# ════════════════════════════════════════════════════════════
# ICO ENCODER (containerwa PNGs)
# ════════════════════════════════════════════════════════════

def write_ico(png_by_size, out_path):
    """
    Empacota dict {size: png_bytes} em arquivo .ico.
    ICO header (6 bytes) + N entradas (16 bytes cada) + payloads.
    """
    sizes = sorted(png_by_size.keys())
    n = len(sizes)

    header = struct.pack("<HHH", 0, 1, n)  # reserved=0, type=1(ICO), count

    entries = bytearray()
    data = bytearray()
    offset = 6 + 16 * n  # header + todas as entradas

    for s in sizes:
        png = png_by_size[s]
        # 0 no campo de width/height significa 256
        w = 0 if s >= 256 else s
        h = 0 if s >= 256 else s
        entries += struct.pack(
            "<BBBBHHII",
            w, h,    # width, height
            0,       # color palette (0 = nao indexado)
            0,       # reserved
            1,       # color planes
            32,      # bits per pixel
            len(png),
            offset
        )
        data += png
        offset += len(png)

    with open(out_path, "wb") as f:
        f.write(header)
        f.write(bytes(entries))
        f.write(bytes(data))


# ════════════════════════════════════════════════════════════
# MAIN
# ════════════════════════════════════════════════════════════

def main():
    sizes = [16, 32, 48, 64, 128, 256]
    here = os.path.dirname(os.path.abspath(__file__))
    out_dir = os.path.dirname(here)  # assets/
    png_dir = os.path.join(here, "png")
    os.makedirs(png_dir, exist_ok=True)

    pngs = {}
    for s in sizes:
        print(f"  rendering {s}x{s}...", flush=True)
        buf = draw_icon(s)
        png = write_png(buf, s)
        pngs[s] = png
        with open(os.path.join(png_dir, f"icon_{s}.png"), "wb") as f:
            f.write(png)

    ico_path = os.path.join(out_dir, "icon.ico")
    write_ico(pngs, ico_path)
    size_bytes = os.path.getsize(ico_path)
    print(f"\nicon.ico written: {ico_path} ({size_bytes} bytes, {len(sizes)} frames)")


if __name__ == "__main__":
    main()
