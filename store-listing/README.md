# Store listing images

`images.json` picks a layout and a capture per image. The `deviceLandscape` layout needs a landscape capture (wider than tall), such as `captures/android/album-landscape.png`; with a portrait capture the image is skipped.

`pnpm store:render --store play` writes the images.
