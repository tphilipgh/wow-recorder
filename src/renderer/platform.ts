/**
 * Platform detection for the renderer.
 *
 * The renderer has no Node process global, so it cannot read process.platform
 * the way the main process does. Preload exposes it on the bridge instead.
 * See src/main/platform.ts for the main process equivalent.
 */

const isMac = window.electron?.platform === 'darwin';

export { isMac };
