import { setTimeout as delay } from 'node:timers/promises';

export async function waitUntil(predicate, { timeout = 5000, interval = 2, label = 'game state' } = {}) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`);
    await delay(interval);
  }
}

export async function quoteAndReady(room, player, name) {
  const id = typeof player === 'string' ? player : player.id;
  await room.action(id, 'quote', { name });
  const quote = room.view(id).me.quotes.at(-1);
  await room.action(id, 'commit', { quoteId: quote.id });
  return quote;
}

export async function prepareRound(room, selections, { awaitResolution = true, timeout = 30000 } = {}) {
  const quotes = await Promise.all(selections.map(({ player, name }) => quoteAndReady(room, player, name)));
  if (awaitResolution) await waitUntil(() => ['roundEnd', 'finished'].includes(room.phase) || room.processingError, { timeout, label: 'prepared round resolution' });
  return quotes;
}

export const prepareLap = prepareRound;
