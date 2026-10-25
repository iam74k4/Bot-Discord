import type { MessageComponentInteraction } from 'discord.js';

/**
 * Persistent component routes.
 *
 * Panels and confirmations answer their own buttons through a collector on
 * the message they sent, and those collectors die with the process. A button
 * that must keep working across restarts - an opt-out on a channel notice,
 * say - is instead registered here by customId prefix, and the interaction
 * router dispatches every matching click to it.
 *
 * Features register in `start()` and call the returned function in `stop()`.
 * Use a feature-specific prefix ending in `:` (`voice-optout:`) and encode
 * what the handler needs in the rest of the customId: the handler is
 * stateless, so it must re-check permissions on every click.
 *
 * A message whose collector is still live is left to that collector even if
 * a route matches (see `liveComponents.ts`), so registering a prefix can never
 * steal clicks from an open panel.
 */
export type PersistentComponentHandler = (
  interaction: MessageComponentInteraction
) => Promise<void>;

export interface ComponentRoute {
  prefix: string;
  handle: PersistentComponentHandler;
}

const routes = new Map<string, ComponentRoute>();

/**
 * Whether every feature has registered its persistent handlers. Features
 * register in `start()`, which runs after the gateway is ready and so after
 * clicks start arriving, and they unregister in `stop()` while clicks still
 * arrive. In those windows a click with no route may well belong to a
 * persistent button whose handler is simply not there yet (or any more), so
 * the router must not grey it out for good; it asks the user to try again.
 * The composition root sets this once features have started and clears it as
 * the first shutdown step.
 */
let routingReady = false;

export function setComponentRoutingReady(ready: boolean): void {
  routingReady = ready;
}

/** False while starting up or shutting down; see `setComponentRoutingReady`. */
export function isComponentRoutingReady(): boolean {
  return routingReady;
}

/**
 * Route every component whose customId starts with `prefix` to `handle`.
 * @returns a function that removes this route again
 * @throws when the prefix is empty or already registered, so two features
 * cannot silently fight over the same buttons
 */
export function registerComponentHandler(
  prefix: string,
  handle: PersistentComponentHandler
): () => void {
  if (!prefix) {
    throw new Error('A component handler needs a non-empty customId prefix');
  }
  if (routes.has(prefix)) {
    throw new Error(
      `A component handler is already registered for "${prefix}"`
    );
  }

  const route: ComponentRoute = { prefix, handle };
  routes.set(prefix, route);

  return () => {
    if (routes.get(prefix) === route) routes.delete(prefix);
  };
}

/** The route for a customId; the longest matching prefix wins. */
export function findComponentHandler(
  customId: string
): ComponentRoute | undefined {
  let best: ComponentRoute | undefined;
  for (const route of routes.values()) {
    if (
      customId.startsWith(route.prefix) &&
      (!best || route.prefix.length > best.prefix.length)
    ) {
      best = route;
    }
  }
  return best;
}

/** Remove every route and mark routing not ready again (tests). */
export function clearComponentHandlers(): void {
  routes.clear();
  routingReady = false;
}
