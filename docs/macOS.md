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
| Preview | Working. Renders into an NSView above the web contents. |
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

macOS gates capture behind TCC, and the app needs three separate grants. Each
is checked at startup and logged.

**Screen Recording** is required for any capture at all, and also for desktop
audio, which goes through ScreenCaptureKit. Without it libobs cannot start a
capture source and cannot even list its properties. It cannot be granted
programmatically: enable it under System Settings > Privacy & Security > Screen
Recording and restart the app.

**Microphone** is required only if a mic source is configured, and is prompted
for normally.

**Accessibility** is required only for push to talk, which installs a global
event tap. uiohook does not degrade gracefully without it: it calls abort()
from its worker thread and takes the process down, which no try/catch can
prevent. So the hook is skipped unless the app is already a trusted
accessibility client, and the prompt is only raised when push to talk is
actually switched on. Everything except push to talk works without it.

Note that a grant is tied to the built app. Rebuilding the .app can invalidate
it, and it will need granting again.

`assets/entitlements.mac.plist` carries the hardened runtime entitlements.
Library validation is disabled there because libobs and its plugins are loaded
at runtime and are not signed with the same identity as the app.

## Differences from Windows

**Capture modes.** Windows has a separate libobs source per capture mode.
macOS has no equivalent of the win-capture graphics hook, so all three modes go
through the single ScreenCaptureKit `screen_capture` source and differ only by
its `type` setting: display, window, or application. Game capture targets WoW
by bundle identifier, `com.blizzard.worldofwarcraft`.

**Audio.** There is no loopback device on macOS: `coreaudio_output_capture`
exists but enumerates zero devices without a virtual audio driver installed.
Desktop audio and per application audio therefore both come from
`sck_audio_capture`, which needs macOS 13 and distinguishes the two with its
own `type` setting rather than by device. Desktop capture takes all system
audio and has nothing to choose, which is why the UI shows a note there instead
of a device dropdown. Application capture picks an app by bundle id.

Microphone input uses `coreaudio_input_capture` and does enumerate real
devices, so mic selection works normally.

Audio source types are still stored in config using their Windows WASAPI ids so
that configs stay portable, and are translated at the point the source is
created. See `toPlatformAudioSourceType` in `src/main/platform.ts`.

**Encoding.** VideoToolbox is the hardware encoder on macOS, the equivalent of
NVENC or AMF on Windows. Its encoder ids come from the OS rather than being
fixed, so they are matched on the `com.apple.videotoolbox.videoencoder.` prefix,
and the hardware ones are identified by an `ave` segment on Apple silicon or
`gva` on Intel. Hardware encoders on Apple silicon support a constant quality
mode, CRF, which is the closest match to the CQP the Windows hardware encoders
use; the software ones only do average bitrate. Note VideoToolbox quality runs
0 to 100 with higher being better, the opposite direction to CQP and CRF
elsewhere.

Unlike Windows, hardware encoding is preferred even at high resolution.
That fallback to software exists because the Windows hardware encoders can
struggle there, whereas VideoToolbox handles it comfortably and x264 on a Mac
would not keep up.

**Combat log watching.** `CombatLogWatcher` uses `fs.watch` on the log
directory. Node makes no promise that the reported event type is consistent
across platforms, and on macOS a directory watch reports everything as
`rename`, including a plain append to an existing file. The watcher therefore
ignores the event type entirely and works out what happened by comparing the
file's creation time and size against what it last saw. Do not reintroduce a
branch on the event type: on macOS it makes every combat log write look like a
file being created or deleted, and nothing is ever parsed or recorded.

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

**The preview view must sit above the web contents.** It is added to the
Electron content view with `addSubview:positioned:NSWindowAbove`. Electron's
web contents fill the window and paint an opaque background, so a preview added
below them renders every frame but is never visible, with no error anywhere to
explain it. The renderer leaves a gap where the preview belongs, the same way
the child HWND arrangement works on Windows.

libobs-opengl attaches an `NSOpenGLContext` to that view, which does not work
with layer backed views, so the subview opts out of layer backing even though
Electron's content view uses it. `create_preview_surface` logs the resulting
state on startup if this ever needs rechecking.

**Preview geometry is in points, not pixels.** The renderer scales the preview
rect by `window.devicePixelRatio` because a Win32 child window works in
physical pixels. AppKit works in points, which are the same as CSS pixels, so
on macOS the factor is 1. Applying the ratio there doubles every coordinate on
a Retina display, and the preview spills far outside its bounds and paints over
the rest of the UI. See `getPreviewScaleFactor` in `RecorderPreview.tsx`.

Note this only misbehaves on a Retina display. On a 1x external monitor the
ratio is 1 and the bug is invisible, so test preview geometry on the built in
display.

**asarUnpack must not use a Windows style glob.** It was `**\**`, where the
backslash is an escape character in the matcher, so on macOS it unpacked
nothing and libobs, its plugins and the addon could not be loaded out of the
asar. It is now `**/*`, which behaves the same on both platforms.

**Running the production bundle unpackaged.** `electron ./release/app` resolves
the preload and the tray icon relative to `release/app`, which only exist there
once packaged. Use `npm start`, or symlink `release/app/.erb` and
`release/app/assets` at the repository copies.

## Known gaps

- **ffmpeg binary** is not packaged. The app falls back to a system install,
  checking the usual Homebrew and MacPorts locations, because a GUI app does
  not inherit the shell PATH. Without one, video cutting fails.
- **Auto-update is disabled on macOS**, as there are no macOS releases to find.
- **Builds are arm64 only.** The electron-builder target lists only arm64
  because libobs is built for the host architecture; an Intel build needs
  libobs built for x86_64 as well.
- **Code signing and notarisation** are not configured. Unsigned builds will be
  blocked by Gatekeeper unless the user explicitly allows them.
- **`libobs-opengl` is deprecated** by Apple. OBS upstream is moving to Metal.
