// Loaded only with --import by a presence-test child process. Keep real clocks,
// timeouts and network I/O, but make scheduled maintenance unavailable so entry
// points must enforce expiry independently of a cleanup sweep.
if (!process.send) throw new Error('The paused-interval helper requires a test child process');
const ordinarySetInterval = globalThis.setInterval;
globalThis.setInterval = (_callback, milliseconds) => {
  process.send({ type: 'test-interval-paused', milliseconds });
  return ordinarySetInterval(() => {}, milliseconds);
};
