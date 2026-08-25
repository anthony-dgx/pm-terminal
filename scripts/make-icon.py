#!/usr/bin/env python3
"""
Build the app icon and the titlebar mark from the source artwork.

Run by hand, not on install:

    python3 scripts/make-icon.py

It is Python because it needs an image library and Node has none in this
project. Nothing at runtime or install time depends on it - it exists so the
icon can be regenerated at a different size, or the crop adjusted, without
anyone having to reverse-engineer a committed PNG.

Two outputs, from one source:

  build/icon.png                        1024px, what electron-builder turns
                                        into the .icns for the bundle
  src/renderer/src/assets/logo.png      256px, the mark in the titlebar

The source is a rectangular illustration on paper, so the crop is computed
rather than hardcoded: find the artwork against the paper, take a square around
it, and scale so the letter fills about 80% of the tile. The remaining 20%, plus
the 100px margin on the 1024 canvas, is the inset macOS icons are expected to
have. A full-bleed icon reads as oversized next to every other one in the Dock.

The paper texture is kept as the tile background rather than being keyed out.
The background is textured, not flat, so a threshold would speckle it and leave
a light fringe on the anti-aliased edges. As a rounded tile it also survives
16px far better than a floating glyph would.
"""
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / 'build' / 'logo-source.jpg'

CANVAS = 1024
# The rounded tile inside that canvas, and its corner radius. Both are the
# proportions Apple's own icons use, near enough.
TILE = 824
RADIUS = 180
# How much of the tile the letter itself takes up.
FILL = 0.80


def artwork_box(im: Image.Image) -> tuple[int, int, int, int]:
    """The bounding box of the illustration, found against the paper."""
    paper = im.getpixel((2, 2))
    diff = ImageChops.difference(im, Image.new('RGB', im.size, paper)).convert('L')
    # 28 is above the paper's own grain and well below any ink.
    box = diff.point(lambda v: 255 if v > 28 else 0).getbbox()
    if box is None:
        raise SystemExit(f'Found no artwork in {SOURCE}, only paper.')
    return box


def main() -> None:
    im = Image.open(SOURCE).convert('RGB')
    left, top, right, bottom = artwork_box(im)
    cx, cy = (left + right) // 2, (top + bottom) // 2
    side = int(max(right - left, bottom - top) / FILL)
    box = (cx - side // 2, cy - side // 2, cx + side // 2, cy + side // 2)
    if box[0] < 0 or box[1] < 0 or box[2] > im.width or box[3] > im.height:
        raise SystemExit(f'A square crop at {FILL} fill runs off the source: {box}')

    tile = im.crop(box).resize((TILE, TILE), Image.LANCZOS)
    # Draw the mask large and scale it down: PIL does not anti-alias a rounded
    # rectangle, so at 1x the corners come out visibly stepped.
    big = Image.new('L', (TILE * 4, TILE * 4), 0)
    ImageDraw.Draw(big).rounded_rectangle(
        [0, 0, TILE * 4 - 1, TILE * 4 - 1], radius=RADIUS * 4, fill=255
    )
    tile.putalpha(big.resize((TILE, TILE), Image.LANCZOS))

    icon = Image.new('RGBA', (CANVAS, CANVAS), (0, 0, 0, 0))
    inset = (CANVAS - TILE) // 2
    icon.paste(tile, (inset, inset), tile)

    for path, size in [
        (ROOT / 'build' / 'icon.png', CANVAS),
        (ROOT / 'src' / 'renderer' / 'src' / 'assets' / 'logo.png', 256),
    ]:
        out = icon if size == CANVAS else icon.resize((size, size), Image.LANCZOS)
        out.save(path)
        print(f'{path.relative_to(ROOT)}  {size}px')


if __name__ == '__main__':
    main()
