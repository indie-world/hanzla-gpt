# Hanzla-GPT

A local AI chat desktop app (Electron) that talks to a locally running
[Ollama](https://ollama.com) instance — chat and code panels side by side, a
video generation tab backed by ComfyUI, and a Chrome bridge that lets the model
read and act on pages in a browser you are already signed into.

Everything runs on your own machine: no cloud model calls, no API keys.

## Download

Grab the latest Windows installer from the
**[Releases page](../../releases/latest)** — `Hanzla-GPT Setup <version>.exe`.

Once installed, the app updates itself: on launch it checks GitHub for a newer
release, asks whether to update, then shows a progress screen and restarts into
the new version. You can also trigger a check from the tray icon →
**Check for updates…**

## Requirements

- Windows x64
- [Ollama](https://ollama.com) running locally (`http://127.0.0.1:11434`)
- Optional: ComfyUI for the video tab (`http://127.0.0.1:8188`)
- Optional: the bundled Chrome extension for the browser bridge

## Chrome bridge (optional)

The app can drive a Chrome window you are already signed into — useful for
reading pages behind a login without handing over credentials.

1. Open `chrome://extensions`, enable **Developer mode**
2. **Load unpacked** → select the `extension/` folder
   (in an installed build: `resources/extension` inside the install directory)
3. The extension connects to the app over `ws://127.0.0.1:8765`

Chrome does not reload unpacked extensions on its own — after updating the app,
click the reload icon on the extension card to pick up the new code.

## Development

```bash
npm install
npm start          # run from source
npm run dist       # build an installer into release/
```

Checks under `scripts/` are standalone Electron runs, e.g.:

```bash
npx electron scripts/e2e.js
```

## Releasing an update

The desktop app watches this repo's Releases, so publishing one is what
triggers the in-app update prompt everywhere.

```bash
npm version patch            # bump the version in package.json
git push && git push --tags
npx electron-builder --win nsis --x64 --publish always
```

`--publish always` uploads the installer plus the `latest.yml` manifest that
`electron-updater` reads. A release without `latest.yml` will not be offered as
an update. Requires `GH_TOKEN` (or `gh auth token`) in the environment.

## Layout

| Path | What's in it |
| --- | --- |
| `src/main.js` | Electron main process: windows, tray, Ollama/ComfyUI calls, local control API |
| `src/updater.js` | GitHub-release auto-update + progress window |
| `src/renderer.js` | Chat UI |
| `src/ext-bridge.js` | WebSocket server the Chrome extension connects to |
| `extension/` | The Chrome extension (MV3) |
| `scripts/` | One-off verification scripts |

## License

MIT
