"""Prepare the eleven visually reviewed plant-name stickers for catalog import.

Requires Pillow, NumPy, and SciPy. Source PNGs are untagged review drafts: this
process assigns sRGB as an explicit booth assumption, not verified provenance.
"""

from pathlib import Path
import argparse
import json
import numpy as np
from PIL import Image, PngImagePlugin
from scipy.ndimage import binary_dilation, label

PLANTS = [
    ("Monstera", "Monstera deliciosa", "monstera-name-silhouette-thicker-review.png", "monstera-grow-slow-review.png", "monstera-leaf-me-be-body-fixed-review.png"),
    ("Sunflower", "Helianthus annuus", "sunflower-name-silhouette-thicker-review.png", "sunflower-suns-out-guns-out-review.png", "sunflower-stay-golden-review.png"),
    ("Chilli plant", "Capsicum annuum", "chilli-name-silhouette-thicker-review.png", "chilli-take-a-chill-pill-review.png", "chilli-too-spicy-for-ya-lettering-fixed.png"),
    ("Strawberry plant", "Fragaria × ananassa", "approved-plant-variations/strawberry/normal.png", "approved-plant-variations/strawberry/berry-sweet.png", "approved-plant-variations/strawberry/berry-brave.png"),
    ("Bird of paradise", "Strelitzia reginae", "approved-plant-variations/bird-of-paradise/normal.png", "approved-plant-variations/bird-of-paradise/paradise-found.png", "approved-plant-variations/bird-of-paradise/born-to-bloom.png"),
    ("Aloe vera", "Aloe vera", "approved-plant-variations/aloe-vera/normal.png", "approved-plant-variations/aloe-vera/aloe-there.png", "approved-plant-variations/aloe-vera/stay-soft.png"),
    ("Bougainvillea", "Bougainvillea glabra", "approved-plant-variations/bougainvillea/normal.png", "approved-plant-variations/bougainvillea/bargain-villa.png", "approved-plant-variations/bougainvillea/bloom-wild.png"),
    ("Snake plant", "Dracaena trifasciata", "approved-plant-variations/snake-plant/normal.png", "approved-plant-variations/snake-plant/stand-tall.png", "approved-plant-variations/snake-plant/low-drama.png"),
    ("Venus flytrap", "Dionaea muscipula", "approved-plant-variations/venus-flytrap/normal.png", "approved-plant-variations/venus-flytrap/snap-to-it.png", "approved-plant-variations/venus-flytrap/gotcha.png"),
    ("Golden barrel cactus", "Kroenleinia grusonii", "approved-plant-variations/golden-barrel-cactus/normal.png", "approved-plant-variations/golden-barrel-cactus/point-taken.png", "approved-plant-variations/golden-barrel-cactus/hug-at-your-risk.png"),
    ("Hibiscus", "Hibiscus rosa-sinensis", "approved-plant-variations/hibiscus/normal.png", "approved-plant-variations/hibiscus/bloom-loud.png", "approved-plant-variations/hibiscus/island-vibes.png"),
]


def prepare(source: Path, target: Path) -> None:
    pixels = np.array(Image.open(source).convert("RGBA"))
    r, g, b, alpha = [pixels[:, :, i].astype(np.int16) for i in range(4)]
    # Same cream selection used in the owner's reviewed sheet assembly.
    cream = ((alpha >= 24) & (r >= 100) & (g >= 90) & (b >= 65)
             & (b <= 245) & (r - g >= -15) & (r - g <= 85)
             & (g - b >= -10) & (g - b <= 95))
    art = (alpha >= 128) & ~cream
    components, _ = label(art)
    sizes = np.bincount(components.ravel())
    art &= (components > 0) & (sizes[components] >= 100)
    if not art.any():
        raise ValueError(f"No artwork after cleaning: {source}")
    # A white paper backing joins the lettering to the illustration for one
    # outward cut. It is white on white stock and creates no printed cream halo.
    backing = binary_dilation(art, iterations=28)
    _, count = label(backing)
    if count != 1:
        raise ValueError(f"Cut backing is disconnected ({count} pieces): {source}")
    out = np.zeros_like(pixels)
    out[backing] = [255, 255, 255, 255]
    out[art, :3] = pixels[art, :3]
    out[art, 3] = 255
    info = PngImagePlugin.PngInfo()
    info.add(b"sRGB", b"\x00")
    Image.fromarray(out, "RGBA").save(target, pnginfo=info, optimize=False)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--source-root", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--prickly-pear", required=True, type=Path)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    roster = []
    for i, (name, scientific, normal, phrase_a, phrase_b) in enumerate(PLANTS):
        file = f"plant-{i:02d}.png"
        prepare(args.source_root / normal, args.output / file)
        prepare(args.source_root / phrase_a, args.output / f"plant-{i:02d}-phrase-a.png")
        prepare(args.source_root / phrase_b, args.output / f"plant-{i:02d}-phrase-b.png")
        roster.append({"name": name, "scientificName": scientific, "file": file,
                       "phraseFiles": [f"plant-{i:02d}-phrase-a.png",
                                       f"plant-{i:02d}-phrase-b.png"]})
    # Keep the existing booth fallback available while adding reviewed plants.
    pear_file = "prickly-pear.png"
    pear = np.array(Image.open(args.prickly_pear).convert("RGBA"))
    info = PngImagePlugin.PngInfo()
    info.add(b"sRGB", b"\x00")
    Image.fromarray(pear, "RGBA").save(args.output / pear_file, pnginfo=info)
    roster.append({"name": "Prickly pear", "file": pear_file})
    for source_name, file in [
        ("devfest-rounded-brand-sticker-review.png", "brand-devfest.png"),
        ("sprout-silhouette-brand-sticker-review.png", "brand-sprout.png"),
    ]:
        pixels = np.array(Image.open(args.source_root / source_name).convert("RGBA"))
        pixels[pixels[:, :, 3] < 128] = [0, 0, 0, 0]
        pixels[pixels[:, :, 3] >= 128, 3] = 255
        _, components = label(pixels[:, :, 3] >= 128)
        if components != 1:
            raise ValueError(f"Brand cut backing is disconnected: {source_name}")
        tagged = PngImagePlugin.PngInfo()
        tagged.add(b"sRGB", b"\x00")
        Image.fromarray(pixels, "RGBA").save(args.output / file, pnginfo=tagged)
    (args.output / "roster.json").write_text(json.dumps(roster, ensure_ascii=False, indent=2) + "\n")


if __name__ == "__main__":
    main()
