"""Regenerate the Windows icon from the original artwork (requires Pillow)."""

from pathlib import Path

from PIL import Image, ImageDraw


def main():
    icons = Path(__file__).resolve().parents[1] / "src-tauri" / "icons"
    with Image.open(icons / "black-cat-icon.png") as source:
        artwork = source.convert("RGBA")

    # Clip inside the flattened source corners so their black fringe is removed.
    inset = round(artwork.width * 0.015)
    artwork = artwork.crop((inset, inset, artwork.width - inset, artwork.height - inset))
    mask = Image.new("L", artwork.size)
    radius = round(artwork.width * 0.24)
    ImageDraw.Draw(mask).rounded_rectangle(
        (0, 0, artwork.width - 1, artwork.height - 1), radius=radius, fill=255
    )
    artwork.putalpha(mask)

    # Area averaging keeps the edge smooth without ringing into clear corners.
    sizes = [(size, size) for size in (16, 24, 32, 48, 64, 256)]
    frames = [artwork.resize(size, Image.Resampling.BOX) for size in sizes]
    frames[-1].save(icons / "icon.ico", sizes=sizes, append_images=frames[:-1])


if __name__ == "__main__":
    main()
