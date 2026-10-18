# Blackcat promo video

`blackcat-promo.mp4` is a 70-second comedy promo for the workbench
(1920×1080, 30 fps, AAC audio, zh-TW on-screen copy). Everything in it is
generated from the files in this folder:

| File | Role |
| --- | --- |
| `promo.html` | The storyboard: twelve timed scenes as HTML/CSS animations. `window.renderAt(t)` seeks every animation to `t` seconds, so frames are deterministic. Open it through a local server with `?play` to watch it in real time (silent). |
| `synth.py` | The chiptune soundtrack and sound effects, Python standard library only, timed to the same scene clock. |
| `render.mjs` | Serves the repository root, captures every frame with Playwright, runs `synth.py` and encodes the MP4 with ffmpeg. |
| `capture-shots.mjs` | Recaptures the app screenshots in `shots/` from the browser mock. |
| `shots/` | Screenshots of the workbench on the built-in demo data and the relation lab. |
| `assets/twemoji/` | The emoji images the video uses (headless Chromium has no color emoji font). |

The cat artwork is read from `src-tauri/icons/black-cat-icon.png`.

## Rebuild

```bash
npm run dev                                   # browser mock on port 1431, only for new screenshots
node docs/promo/capture-shots.mjs             # optional: refresh shots/
node docs/promo/render.mjs --probe 4.6 21.5   # check single frames in output/promo/probe
node docs/promo/render.mjs                    # all frames + audio -> docs/promo/blackcat-promo.mp4
```

`render.mjs` needs an ffmpeg build with libx264 and AAC (`FFMPEG=/path/to/ffmpeg`
when it is not on `PATH`) and Python 3 (`PYTHON`). Frames and the WAV go to the
gitignored `output/promo/`. A full render takes a few minutes.

Scene times live in each `<section data-t data-end>` of `promo.html`; when a
scene moves, move its cues in `synth.py`'s `build()` as well.

## Credits

Emoji graphics are from [Twemoji](https://github.com/jdecked/twemoji),
© Twitter, Inc. and other contributors, licensed under
[CC-BY 4.0](https://creativecommons.org/licenses/by/4.0/). The testimonial in
the video is a fictional joke.
