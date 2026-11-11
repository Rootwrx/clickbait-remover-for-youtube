# Clickbait Remover for YouTube

A browser extension for Chrome and Firefox that removes YouTube clickbait: it replaces misleading thumbnails with a real frame from the video and tidies up clickbait titles.

> Not affiliated with, endorsed by, or sponsored by YouTube or Google.

## Features

- **Real frames instead of clickbait.** Shows the frame at 25%, 50% or 75% of the video, or lets the extension pick the best one.
- **Skips dull frames.** Rejects black, washed-out, flat or blurry frames and falls back to a better one.
- **Sharper images.** Downloads the full-size frame and crops the black letterbox bars off.
- **Peek at the original.** Hover a thumbnail to see the uploader's version (delay is adjustable).
- **Title cleanup.** Removes emoji, ALL CAPS, hype tags like `[GONE WRONG]` and `!!!` spam. Useful tags like `(4K)` or `(Live)` are kept.
- **Leaves live streams alone.** Live and upcoming videos keep their original thumbnail, since they have no real middle.
- Light and dark popup, instant settings, no accounts, no tracking.

## Install

Download the zip for your browser from the [Releases](../../releases) page.

### Chrome, Edge, Brave

1. Extract the zip into a folder.
2. Open `chrome://extensions` and turn on **Developer mode**.
3. Click **Load unpacked** and select the extracted folder (the one containing `manifest.json`).

### Firefox

Temporary install (removed when Firefox closes):

1. Extract the zip.
2. Open `about:debugging#/runtime/this-firefox`.
3. Click **Load Temporary Add-on** and select `manifest.json`.
4. Open `about:addons`, click the extension, go to **Permissions**, and allow site access for youtube.com and ytimg.com.

Permanent install: release Firefox only keeps *signed* add-ons. Submit the zip to [addons.mozilla.org](https://addons.mozilla.org/developers/) as **On your own** (unlisted) to get it signed for free, or use Firefox Developer Edition / Nightly with `xpinstall.signatures.required` set to `false`.

## Build from source

Requires Python 3.

```bash
python build.py
```

This writes unpacked builds to `dist/chrome` and `dist/firefox`, plus release zips in `dist/`. Load the unpacked folder directly while developing.

### Making a release

1. Bump `version` in both files in `manifests/`.
2. Commit, then tag and push:
   ```bash
   git tag v2.0.1
   git push origin v2.0.1
   ```
3. The **Release** workflow builds both zips and attaches them to a GitHub release.

## How it works

YouTube keeps three auto-generated frames for every video (`mq1`/`mq2`/`mq3`, `sd1`/`sd2`/`sd3`, `hq1`/`hq2`/`hq3`), taken at roughly 25%, 50% and 75%.

- `src/content.js` finds thumbnail images, swaps them, handles hover-to-reveal, skips live streams and cleans titles.
- `src/background.js` downloads the frames (the page can't read their pixels), scores them for brightness, contrast and sharpness, and crops letterbox bars from the full-size version.
- `src/popup.*` is the settings UI. Settings sync through `chrome.storage.sync`.

## Limitations

- YouTube changes its page markup often, so the title and live-badge selectors may need occasional updates. Thumbnails are matched by image URL, which is more stable.
- Shorts are skipped.
- The dull-frame check is a heuristic. It won't catch everything, such as a mid-blink face or a cross-fade.
- The largest middle frames YouTube offers are 640 px wide, so on very large screens they can look softer than the uploader's own thumbnail.
- Not every video has every frame size. The extension falls back to smaller sizes automatically.

## Privacy

The extension collects no data and has no server. It only talks to `i.ytimg.com` (to fetch thumbnail frames) and stores your settings and a local cache of frame scores in your browser.

## License

[MIT](LICENSE)
