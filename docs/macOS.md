# macOS

Warcraft Recorder was written for Windows. This document covers what the macOS
port needs, how to build it, and what is not done yet.

## Status

| Area | State |
|---|---|
| libobs build | Working. Builds from source with Ninja, no full Xcode needed. |
| noobs native addon | Working. Initialises libobs, loads plugins. |
| Video capture | Display, window and application capture via ScreenCaptureKit. |
| Audio capture | Mic via CoreAudio, desktop and app audio via ScreenCaptureKit. |
| Video encoding | VideoToolbox H.264 and HEVC, x264 software fallback. |
| Log parsing, UI, video library | Unchanged. These were already portable. |
| Preview | Renders into an NSView. See the caveat below. |
| Code signing and notarisation | Not set up. |

## Building

The build has three repositories: a libobs fork, the `noobs` native addon that
wraps it, and this app. They are expected to sit next to each other:

```
wcrecorder/
  obs/     github.com/aza547/warcraft-recorder-obs-studio  (branch macos-ninja)
  noobs/   github.com/aza547/noobs                         (branch macos-port)
  wcr/     this repository                                 (branch macos-port)
```

You need Node, CMake, Ninja and the Xcode Command Line Tools. Full Xcode is
**not** required.

```bash
brew install node cmake ninja
```

### 1. Build libobs

OBS only supports the Xcode generator on macOS, which would mean installing all
of Xcode to build what is effectively a headless library. The `macos-ninja`
branch relaxes that so the pieces we need build under Ninja. The Qt frontend,
browser source, virtual camera and websocket server are all left out.

```bash
cd obs
cmake -S . -B build_mac -G Ninja \
  -DOBS_VERSION_OVERRIDE=31.1.2 \
  -DCMAKE_BUILD_TYPE=RelWithDebInfo \
  -DCMAKE_OSX_DEPLOYMENT_TARGET=13.0 \
  -DENABLE_UI=OFF -DENABLE_BROWSER=OFF -DENABLE_SCRIPTING=OFF \
  -DENABLE_VIRTUALCAM=OFF -DENABLE_WEBSOCKET=OFF -DENABLE_SPARKLE_UPDATER=OFF

cmake --build build_mac --parallel --target \
  libobs mac-capture obs-ffmpeg obs-x264 obs-filters image-source \
  mac-videotoolbox coreaudio-encoder mac-avcapture obs-transitions
```

Build the listed targets rather than everything: `obs-vst` fails to link
because it wants the AGL framework, which Apple removed, and we do not use it.

### 2. Stage and build noobs

`stage-macos.js` copies libobs, the graphics module, the plugins and the
ffmpeg-mux helper out of the OBS build and rewrites their install names to
`@rpath` so the tree can be relocated. The Xcode generator would normally do
that for us.

```bash
cd noobs
npm install
node scripts/stage-macos.js ../obs/build_mac
npm run build          # node-gyp rebuild && node dist.js
```

### 3. Build the app

```bash
cd wcr
npm install
cd release/app && npm install && cd ../..
npm start
```

`noobs` is consumed as a local file dependency from `release/app/package.json`,
so it picks up your build of the addon.

Note that `electron-rebuild` recompiles `noobs` for Electron's ABI but does not
repackage it, so after any rebuild of native modules run `node dist.js` in the
`noobs` checkout again, otherwise `dist/noobs.node` is left built against your
system Node and will fail to load.

## Permissions

macOS gates capture behind TCC. On first record the app will prompt for Screen
Recording, and for Microphone if a mic source is configured. Screen Recording
cannot be granted programmatically; if the prompt is dismissed the user has to
enable it under System Settings > Privacy & Security > Screen Recording, and
restart the app.

`assets/entitlements.mac.plist` carries the hardened runtime entitlements.
Library validation is disabled there because libobs and its plugins are loaded
at runtime and are not signed with the same identity as the app.

## Differences from Windows

**Capture modes.** Windows has a separate libobs source per capture mode.
macOS has no equivalent of the win-capture graphics hook, so all three modes go
through the single ScreenCaptureKit `screen_capture` source and differ only by
its `type` setting: display, window, or application. Game capture targets WoW
by bundle identifier, `com.blizzard.worldofwarcraft`.

**Audio.** There is no loopback device on macOS. Desktop audio and per
application audio both come from `sck_audio_capture`, which needs macOS 13.
Microphone input uses `coreaudio_input_capture`.

Audio source types are still stored in config using their Windows WASAPI ids so
that configs stay portable, and are translated at the point the source is
created. See `toPlatformAudioSourceType` in `src/main/platform.ts`.

**Process detection.** Windows shells out to a bundled `rust-ps.exe`. macOS
polls `ps` and matches on the flavour directory in the process path, which
covers `_retail_`, `_classic_` and `_classic_era_`.

**ffmpeg.** `VideoProcessQueue` uses the ffmpeg binary packaged alongside
libobs. The macOS obs-deps do not ship an ffmpeg CLI, so this currently
resolves to a binary that is not there. Install ffmpeg separately for video
cutting to work.

## Gotchas

**src/main/platform.ts is main process only.** Despite living under
`src/main`, a lot of that directory is bundled into the renderer too, and
`src/main/constants.ts` in particular is imported by much of the UI. The
renderer has no Node `process` global, so importing the platform module from
anything the renderer reaches throws at module load and the window comes up
empty. The window is frameless and draws its own title bar, so when that
happens there is no close button either. Do the platform branch in a file the
renderer never touches.

**Running the production bundle unpackaged.** `electron ./release/app` resolves
the preload and the tray icon relative to `release/app`, which only exist there
once packaged. Use `npm start`, or symlink `release/app/.erb` and
`release/app/assets` at the repository copies.

## Known gaps

- **Preview.** libobs-opengl attaches an `NSOpenGLContext` to the view, which
  does not work with layer backed views. Electron's content view is layer
  backed, so the preview subview explicitly opts out. This is still untested:
  recording works, but nothing has yet confirmed the preview in the scene
  editor actually renders. If it comes up black, the fallback is a separate
  child `NSWindow`.
- **ffmpeg binary** is not packaged, as above.
- **Code signing and notarisation** are not configured. Unsigned builds will be
  blocked by Gatekeeper unless the user explicitly allows them.
- **Universal binaries.** Everything is built for the host architecture only.
  The `dmg` and `zip` targets list `arm64` and `x64`, but an Intel build needs
  libobs built for `x86_64` too.
- **`libobs-opengl` is deprecated** by Apple. OBS upstream is moving to Metal.
