// Loaded only by the cross-round bot test's server child. Three players retain
// their order, the first pair stays separate, and the third deposit chains twice.
if (!process.send) throw new Error('The chain-reaction helper requires a test child process');
const draws = [1, 1, 1, 0, 0];
Math.random = () => draws.shift() ?? 0;
