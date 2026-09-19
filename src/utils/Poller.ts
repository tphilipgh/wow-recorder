import EventEmitter from 'events';
import { ChildProcessWithoutNullStreams, spawn, execFile } from 'child_process';
import path from 'path';
import { app } from 'electron';
import ConfigService from 'config/ConfigService';
import { WowProcessEvent } from 'main/types';
import { isWindows } from 'main/platform';

/**
 * How often we check the process list on platforms where we poll ourselves
 * rather than using the rust-ps helper. The Windows helper polls internally
 * at a similar rate.
 */
const UNIX_POLL_INTERVAL_MS = 5000;

/**
 * The Poller singleton periodically checks the list of WoW active
 * processes. If the state changes, it emits a WowProcessEvent.
 */
export default class Poller extends EventEmitter {
  /**
   * Singleton instance.
   */
  private static instance: Poller;

  /**
   * Config service handle.
   */
  private cfg: ConfigService = ConfigService.getInstance();

  /**
   * If a WoW process is running AND the corresponding record config is
   * enabled. Includes various flavours of retail, classic and era.
   */
  private wowRunning = false;

  /**
   * Spawned child process.
   */
  private child: ChildProcessWithoutNullStreams | undefined;

  /**
   * Interval handle for the unix poller.
   */
  private timer: NodeJS.Timeout | undefined;

  /**
   * Singleton instance.
   */
  private binary = app.isPackaged
    ? path.join(process.resourcesPath, 'binaries', 'rust-ps.exe')
    : path.join(__dirname, '../../binaries', 'rust-ps.exe');

  /**
   * Create or get the singleton.
   */
  static getInstance() {
    if (!Poller.instance) Poller.instance = new Poller();
    return Poller.instance;
  }

  /**
   * Private constructor as part of the singleton pattern.
   */
  private constructor() {
    super();
  }

  /**
   * Convienence method to check if WoW is running. Only returns true if WoW
   * is running, and the configuration is setup to record that flavour of WoW.
   */
  public isWowRunning() {
    return this.wowRunning;
  }

  /**
   * Stop the poller and reset the state.
   */
  public stop() {
    console.info('[Poller] Stop process poller');
    this.wowRunning = false;

    if (this.child) {
      this.child.kill();
      this.child = undefined;
    }

    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /**
   * Start the poller.
   */
  public start() {
    this.stop();
    console.info('[Poller] Start process poller');

    if (!isWindows) {
      // No rust-ps helper outside of Windows, poll the process list here.
      this.timer = setInterval(this.pollUnix, UNIX_POLL_INTERVAL_MS);
      this.pollUnix();
      return;
    }

    this.child = spawn(this.binary);
    this.child.stdout.on('data', this.handleStdout);
    this.child.stderr.on('data', this.handleStderr);
  }

  /**
   * Check the process list for a running WoW. The game lives under a flavour
   * directory (e.g. _retail_, _classic_, _classic_era_) on all platforms, so
   * match on that rather than the executable name which differs by flavour
   * and locale.
   */
  private pollUnix = () => {
    execFile('ps', ['-axo', 'command='], (err, stdout) => {
      if (err) {
        console.warn('[Poller] Failed to list processes', String(err));
        return;
      }

      // Exclude our own process, which has the log path (and hence the
      // flavour directory) on its command line in some configurations.
      const lines = stdout
        .split('\n')
        .filter((line) => !line.includes('WarcraftRecorder'));

      const Retail = lines.some((line) => line.includes('/_retail_/'));
      const Classic = lines.some((line) => line.includes('/_classic_'));

      this.handleProcessState(Retail, Classic);
    });
  };

  /**
   * Handle stdout data from the child process, this is a tiny blob of JSON
   * in the format {"Retail":true, "Classic":false}.
   *
   * We don't care to do anything better in the scenario of multiple processes
   * running. We don't support users multi-boxing.
   */
  private handleStdout = (data: string) => {
    let parsed;

    try {
      parsed = JSON.parse(data);
    } catch {
      // We can hit this on sleeping/resuming from sleep. Or anything
      // else that blocks the event loop long enough to cause us to end up
      // with more than one JSON entry. This used to log but it was just
      // messy and experience has demonstrated it's never interesting.
      return;
    }

    const { Retail, Classic } = parsed;
    this.handleProcessState(Retail, Classic);
  };

  /**
   * Given whether a retail and/or classic WoW process is running, work out
   * if that means we consider WoW to be running given the user's config,
   * and emit an event if that has changed.
   */
  private handleProcessState(Retail: boolean, Classic: boolean) {
    const recordRetail = this.cfg.get<boolean>('recordRetail');
    const recordRetailPtr = this.cfg.get<boolean>('recordRetailPtr');
    const recordClassic = this.cfg.get<boolean>('recordClassic');
    const recordClassicPtr = this.cfg.get<boolean>('recordClassicPtr');
    const recordEra = this.cfg.get<boolean>('recordEra');

    const running =
      ((recordRetail || recordRetailPtr) && Retail) ||
      ((recordClassic || recordClassicPtr || recordEra) && Classic);

    if (this.wowRunning === running) {
      // Nothing to emit.
      return;
    }

    if (running) {
      this.emit(WowProcessEvent.STARTED);
    } else {
      this.emit(WowProcessEvent.STOPPED);
    }

    this.wowRunning = running;
  }

  /**
   * Handle stderr, we don't expect to ever see this but log it incase
   * anything weird happens.
   */
  private handleStderr = (data: string) => {
    console.warn('[Poller] stderr returned from child process');
    console.error(data);
  };
}
