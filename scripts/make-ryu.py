#!/usr/bin/env python3
"""Generate Ryu, the pixel dragon, into src/renderer/src/assets/ryu/.

Run by hand: python3 scripts/make-ryu.py

Ryu is an eastern dragon - Shenron and Rayquaza, in red - so his body is one
long serpent rather than a compact silhouette. That is why he is generated
instead of hand-drawn: the trunk is a sampled curve, and nudging the curve by
hand across two layers and a dozen files is how the seam between body and tail
ends up in the wrong place.

Everything lands on a 24-unit grid inside a 2400x1440 viewBox. The 5:3 shape is
deliberate: .kroks-cat.is-dragon is 190x114px, the same ratio, so object-fit:
contain fits the art exactly with no letterboxing. Every file here must carry
that identical viewBox or its layer scales differently from the rest.
"""

from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "src/renderer/src/assets/ryu"
W, H = 2400, 1440
G = 24  # one pixel of the art, about 1.9 screen px at 190px wide

# ---- palette --------------------------------------------------------------
RED = "#d13a4a"      # body
RED_MID = "#c1263a"  # second row down the back
RED_DK = "#a8203a"   # deepest shade, limbs
OUTLINE = "#8f2130"  # the dark line along the spine
BELLY = "#f0748a"
SCALE = "#d9556a"    # belly seam
BONE = "#f7d488"
BONE_HI = "#fff0c2"
BONE_DK = "#d8ab5e"
MAW = "#33070f"
TONGUE = "#a8203a"
PUPIL = "#2a0a10"
FIRE_HOT = "#fff0c2"
FIRE_MID = "#ffd166"
FIRE_LOW = "#f9a03f"
FIRE_TIP = "#ef4b2c"

# ---- the serpent's spine --------------------------------------------------
# (x, centre y) from the tail tip on the left to the base of the neck. Two
# humps: it has to read as swimming even while every layer is still.
SPINE = [
    (96, 1008), (240, 1128), (432, 1200), (648, 1176), (840, 1056),
    (1008, 912), (1176, 840), (1320, 888), (1440, 864), (1536, 768),
    (1656, 600),
]
# (x, half-thickness), tapering to nothing at the tip and narrowing into the neck.
GIRTH = [
    (96, 12), (240, 36), (432, 60), (648, 78), (840, 90),
    (1008, 96), (1176, 96), (1320, 96), (1440, 90), (1536, 84), (1656, 72),
]

# The tail is its own layer so it can rotate. The two layers share this column,
# and the tail's transform-origin sits in the middle of it: a rotation about a
# point a few percent off would open a notch, and the overlap hides that.
JOIN = 888
TRUNK_END = 1656  # where the neck stops and the skull takes over

HEAD_X = 1656  # left edge of the skull, everything on the head keys off it


def snap(v: float) -> int:
    return int(round(v / G) * G)


def sample(table: list[tuple[int, int]], x: float) -> float:
    """Linear interpolation through a control-point table."""
    if x <= table[0][0]:
        return float(table[0][1])
    for (x0, y0), (x1, y1) in zip(table, table[1:]):
        if x <= x1:
            return y0 + (y1 - y0) * (x - x0) / (x1 - x0)
    return float(table[-1][1])


def rect(x: int, y: int, w: int, h: int, fill: str) -> str:
    return f'<rect x="{x}" y="{y}" width="{w}" height="{h}" fill="{fill}"/>'


def write(name: str, rects: list[str]) -> None:
    body = "\n".join(r for r in rects if r)
    svg = (
        f'<svg width="{W}" height="{H}" viewBox="0 0 {W} {H}" '
        f'shape-rendering="crispEdges" xmlns="http://www.w3.org/2000/svg">\n'
        f"{body}\n</svg>\n"
    )
    (OUT / name).write_text(svg)
    print(f"{name}: {len(rects)} rects")


def trunk(x_from: int, x_to: int) -> list[str]:
    """One column of scales per grid step, following the spine."""
    out: list[str] = []
    for x in range(x_from, x_to, G):
        cy = snap(sample(SPINE, x + G / 2))
        th = snap(sample(GIRTH, x + G / 2))
        if th < G:
            continue
        top, height = cy - th, th * 2
        out.append(rect(x, top, G, height, RED))
        out.append(rect(x, top, G, G, OUTLINE))
        if height >= 96:
            out.append(rect(x, top + G, G, G, RED_MID))
        if height >= 144:
            out.append(rect(x, cy + th - 2 * G, G, 2 * G, BELLY))
        if height >= 192:
            out.append(rect(x, cy + th - 3 * G, G, G, SCALE))
        # A bone ridge down the back, every fourth column. Rayquaza's fins.
        if th >= 48 and (x // G) % 4 == 0:
            out.append(rect(x, top - 2 * G, G, 2 * G, BONE))
    return out


def build_tail() -> None:
    r = trunk(96, JOIN + G)
    # The tip splits into a two-pronged bone fluke, so the thin end still has a
    # silhouette once the trunk has tapered below one grid square.
    r += [
        rect(72, 984, 48, 48, BONE_DK),
        rect(24, 912, 48, 96, BONE),
        rect(0, 888, 24, 72, BONE_HI),
        rect(24, 1008, 48, 96, BONE),
        rect(0, 1056, 24, 72, BONE_HI),
    ]
    write("tail.svg", r)


def build_body() -> None:
    write("body.svg", trunk(JOIN, TRUNK_END))


def barbels(drop: int = 0) -> list[str]:
    """The two whiskers. `drop` follows the lower one down with the jaw. Both
    have to start on the snout itself - a barbel with a gap under it reads as
    a stray pixel, not a whisker."""
    return [
        rect(2112, 504, 96, 24, BONE),
        rect(2208, 456, 96, 24, BONE),
        rect(2304, 432, 72, 24, BONE),
        rect(1992, 672 + drop, 96, 24, BONE),
        rect(2064, 696 + drop, 72, 24, BONE),
        rect(2112, 720 + drop, 48, 72, BONE),
    ]


def build_head_normal() -> None:
    x = HEAD_X
    write("head-normal.svg", [
        # The skull starts one column behind HEAD_X so it laps over the last
        # column of the neck. The head layer breathes on its own timer, and
        # without the overlap that 2px opens a notch at the throat.
        rect(x - 24, 432, 336, 264, RED),         # skull
        rect(x - 24, 432, 336, 48, OUTLINE),      # brow
        rect(x + 312, 528, 192, 144, RED),        # snout
        rect(x + 312, 528, 192, 24, OUTLINE),
        rect(x + 312, 624, 192, 24, OUTLINE),     # mouth, closed
        rect(x + 336, 648, 168, 24, BELLY),       # jaw, lit from below
        rect(x + 456, 552, 24, 24, OUTLINE),      # nostril
        rect(x + 96, 672, 216, 24, OUTLINE),      # under-chin shade
    ] + barbels())


def build_head_open() -> None:
    """Jaw swung down. It has to hold up on its own, because the sleeping pose
    shows this head with no mouth layer over it."""
    x = HEAD_X
    write("head-open.svg", [
        rect(x - 24, 432, 336, 264, RED),
        rect(x - 24, 432, 336, 48, OUTLINE),
        rect(x + 312, 528, 192, 96, RED),         # upper jaw only
        rect(x + 312, 528, 192, 24, OUTLINE),
        rect(x + 456, 552, 24, 24, OUTLINE),
        rect(x + 216, 624, 288, 120, MAW),        # the open mouth itself
        rect(x + 192, 744, 312, 72, RED),         # lower jaw
        rect(x + 192, 744, 312, 24, OUTLINE),
        rect(x + 216, 792, 264, 24, BELLY),
        rect(x + 96, 672, 120, 24, OUTLINE),
    ] + barbels(drop=120))


def build_mouth() -> None:
    """Only what sits inside the maw. The maw is part of head-open."""
    x = HEAD_X
    write("mouth-open.svg", [
        rect(x + 240, 696, 216, 48, TONGUE),
        rect(x + 264, 624, 48, 48, BONE_HI),      # fangs
        rect(x + 408, 624, 48, 48, BONE_HI),
    ])


def build_eyes() -> None:
    x = HEAD_X
    write("eyes-open.svg", [
        rect(x + 72, 504, 96, 72, FIRE_MID),
        rect(x + 144, 504, 24, 72, PUPIL),
        rect(x + 192, 504, 96, 72, FIRE_MID),
        rect(x + 264, 504, 24, 72, PUPIL),
    ])
    write("eyes-closed.svg", [
        rect(x + 72, 552, 96, 24, PUPIL),
        rect(x + 192, 552, 96, 24, PUPIL),
    ])


def antler(base_x: int) -> list[str]:
    """One horn, rooted on the skull and sweeping back over it."""
    return [
        rect(base_x, 360, 96, 120, BONE),
        rect(base_x - 48, 288, 96, 96, BONE),
        rect(base_x - 72, 264, 48, 48, BONE_HI),
        rect(base_x + 48, 408, 48, 48, BONE_DK),
    ]


def build_horns() -> None:
    # 264 is the topmost ink in the whole cast, on purpose. The hover peaks at
    # -7px and the swoop adds -5px more; any higher and the tips clip on
    # .kroks-stage, which is overflow: hidden.
    write("horn-left.svg", antler(HEAD_X + 24))
    write("horn-right.svg", antler(HEAD_X + 192))


def limb(shoulder_x: int, shoulder_y: int, mid: str) -> list[str]:
    """A short clawed foreleg. Eastern dragons have no bat wings, so the two
    layers behind the body are limbs paddling rather than a membrane beating."""
    return [
        rect(shoulder_x, shoulder_y, 72, 96, RED_DK),
        rect(shoulder_x - 48, shoulder_y + 72, 72, 96, mid),
        rect(shoulder_x - 72, shoulder_y + 168, 48, 48, BONE),
        rect(shoulder_x, shoulder_y + 168, 48, 48, BONE),
        rect(shoulder_x - 48, shoulder_y + 216, 72, 24, BONE_DK),
    ]


def build_limbs() -> None:
    write("limb-left.svg", limb(984, 984, RED_MID))    # rear, further from us
    write("limb-right.svg", limb(1392, 960, RED))      # front


def build_flame() -> None:
    """Breathed forward out of the open mouth, whose front edge is at x=2160."""
    write("flame.svg", [
        rect(2160, 648, 72, 72, FIRE_HOT),      # the core, at the lip
        rect(2232, 624, 72, 120, FIRE_MID),     # widening
        rect(2304, 600, 48, 168, FIRE_MID),
        rect(2304, 552, 48, 48, FIRE_LOW),
        rect(2280, 768, 72, 48, FIRE_LOW),
        rect(2352, 624, 48, 120, FIRE_LOW),
        rect(2376, 576, 24, 48, FIRE_TIP),      # ragged tips
        rect(2352, 744, 48, 48, FIRE_TIP),
        rect(2208, 720, 48, 48, FIRE_TIP),
    ])


if __name__ == "__main__":
    build_tail()
    build_body()
    build_head_normal()
    build_head_open()
    build_mouth()
    build_eyes()
    build_horns()
    build_limbs()
    build_flame()
