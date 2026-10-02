/**
 * One shared requestAnimationFrame loop for every animation on the page,
 * so several canvases never schedule competing frames.
 */
export type TickHandler = (time: number, delta: number) => void;

const handlers = new Set<TickHandler>();
let rafId: number | null = null;
let lastTime: number | null = null;

function tick(time: number): void {
  const delta = lastTime === null ? 0 : time - lastTime;
  lastTime = time;
  for (const handler of handlers) handler(time, delta);
  rafId = handlers.size > 0 ? requestAnimationFrame(tick) : null;
}

/** Subscribes to animation frames; returns the unsubscribe function. */
export function onTick(handler: TickHandler): () => void {
  handlers.add(handler);
  if (rafId === null) {
    lastTime = null;
    rafId = requestAnimationFrame(tick);
  }
  return () => {
    handlers.delete(handler);
    if (handlers.size === 0 && rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
  };
}
