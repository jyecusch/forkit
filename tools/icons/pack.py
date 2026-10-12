"""Packs PNGs into Windows .ico and macOS .icns files, which both simply
hold PNG data behind a small header.

    python3 pack.py ico OUTPUT PNG...
    python3 pack.py icns OUTPUT PNG...
"""

import struct
import sys

# The .icns entries a full icon has, and the pixel size each needs. Retina
# (@2x) entries reuse the image of twice the point size.
ICNS_ENTRIES = [
    (b"icp4", 16), (b"ic11", 32),    # 16 pt, @2x
    (b"icp5", 32), (b"ic12", 64),    # 32 pt, @2x
    (b"ic07", 128), (b"ic13", 256),  # 128 pt, @2x
    (b"ic08", 256), (b"ic14", 512),  # 256 pt, @2x
    (b"ic09", 512), (b"ic10", 1024), # 512 pt, @2x
]


def png_size(png: bytes) -> int:
    width, height = struct.unpack(">II", png[16:24])
    if width != height:
        raise ValueError("icons must be square")
    return width


def ico(pngs: list[bytes]) -> bytes:
    entries, offset = b"", 6 + 16 * len(pngs)
    for png in pngs:
        size = png_size(png)
        dimension = 0 if size >= 256 else size  # 0 means 256
        entries += struct.pack("<BBBBHHII", dimension, dimension, 0, 0, 1, 32, len(png), offset)
        offset += len(png)
    return struct.pack("<HHH", 0, 1, len(pngs)) + entries + b"".join(pngs)


def icns(pngs: list[bytes]) -> bytes:
    by_size = {png_size(png): png for png in pngs}
    missing = {size for _, size in ICNS_ENTRIES} - by_size.keys()
    if missing:
        raise ValueError(f"icns needs images of sizes {sorted(missing)}")
    chunks = b"".join(kind + struct.pack(">I", 8 + len(by_size[size])) + by_size[size] for kind, size in ICNS_ENTRIES)
    return b"icns" + struct.pack(">I", 8 + len(chunks)) + chunks


if __name__ == "__main__":
    kind, output, *paths = sys.argv[1:]
    images = [open(path, "rb").read() for path in paths]
    with open(output, "wb") as f:
        f.write({"ico": ico, "icns": icns}[kind](images))
