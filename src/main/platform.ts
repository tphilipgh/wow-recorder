/**
 * Platform abstraction. Warcraft Recorder was originally Windows only, so a
 * lot of the codebase assumed Windows paths, binaries and process names.
 * Anything that differs between platforms should live here rather than being
 * sprinkled through the app with inline process.platform checks.
 */

// This module is for the main process. It must not be imported, directly or
// transitively, by anything the renderer bundles: the renderer has no Node
// process global, and touching it there throws at module load and leaves the
// window blank. The guard keeps that failure mode from being silent.
const platform = typeof process === 'undefined' ? '' : process.platform;

const isWindows = platform === 'win32';
const isMac = platform === 'darwin';
const isLinux = platform === 'linux';

/**
 * Suffix for native executables we ship or shell out to. Empty on unix.
 */
const exeSuffix = isWindows ? '.exe' : '';

/**
 * Name of the ffmpeg binary packaged alongside libobs in noobs.
 */
const ffmpegBinaryName = `ffmpeg${exeSuffix}`;

/**
 * Name of the ffprobe binary packaged alongside libobs in noobs.
 */
const ffprobeBinaryName = `ffprobe${exeSuffix}`;

/**
 * Directories we search for a World of Warcraft installation on first time
 * setup. The flavour directory (e.g. _retail_) is appended to these.
 */
const getWowInstallSearchPaths = (): string[] => {
  if (isMac) {
    return [
      '/Applications/World of Warcraft',
      `${process.env.HOME}/Applications/World of Warcraft`,
    ];
  }

  if (isLinux) {
    // Common Lutris/Wine prefix layouts. Best effort only.
    return [
      `${process.env.HOME}/Games/world-of-warcraft/drive_c/World of Warcraft`,
      `${process.env.HOME}/.wine/drive_c/Program Files (x86)/World of Warcraft`,
    ];
  }

  return [];
};

/**
 * libobs source type ids for video capture.
 *
 * Windows has a dedicated source per capture mode. macOS has no graphics hook
 * equivalent to win-capture, so all three modes go through ScreenCaptureKit's
 * single screen_capture source, which distinguishes them with its 'type'
 * setting.
 */
const captureSourceType = {
  monitor: isMac ? 'screen_capture' : 'monitor_capture',
  window: isMac ? 'screen_capture' : 'window_capture',
  game: isMac ? 'screen_capture' : 'game_capture',
};

/**
 * Values for the ScreenCaptureKit source's 'type' setting. Mirrors
 * ScreenCaptureStreamType in mac-sck-common.h.
 */
enum SckStreamType {
  DISPLAY = 0,
  WINDOW = 1,
  APPLICATION = 2,
}

/**
 * Bundle identifier for World of Warcraft, used to target the game with
 * ScreenCaptureKit application capture. This is macOS's closest equivalent to
 * game capture on Windows.
 */
const WOW_BUNDLE_ID = 'com.blizzard.worldofwarcraft';

/**
 * Values for the ScreenCaptureKit audio source's 'type' setting.
 */
enum SckAudioType {
  DESKTOP = 0,
  APPLICATION = 1,
}

/**
 * Translate the audio source type stored in config, which is always the
 * Windows WASAPI id so that configs stay portable, into the libobs source
 * type id for this platform.
 *
 * macOS has no loopback device, so desktop and per application audio both go
 * via ScreenCaptureKit.
 */
const toPlatformAudioSourceType = (type: string): string => {
  if (!isMac) return type;
  if (type === 'wasapi_input_capture') return 'coreaudio_input_capture';
  return 'sck_audio_capture';
};

export {
  isWindows,
  isMac,
  isLinux,
  exeSuffix,
  ffmpegBinaryName,
  ffprobeBinaryName,
  getWowInstallSearchPaths,
  captureSourceType,
  toPlatformAudioSourceType,
  SckStreamType,
  SckAudioType,
  WOW_BUNDLE_ID,
};
