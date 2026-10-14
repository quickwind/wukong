// Irix edition switch for the web app. Set at build time (EXPO_PUBLIC_IRIX=1) so the
// bundle carries no dead voice or GitHub entry points. Unset in upstream builds and tests.
export const IRIX_BUILD =
  process.env.EXPO_PUBLIC_IRIX === "1" || process.env.EXPO_PUBLIC_WUKONG === "1";

// COMPAT(wukong): alias for backward compatibility
export const WUKONG_BUILD = IRIX_BUILD;

/** For a row Irix removes without moving upstream's JSX: keeps the diff to one line. */
export const HIDDEN_ROW_STYLE = { display: "none" } as const;

const Hidden = () => null;

/**
 * An upstream component Irix does not show. Swapping the component a JSX tag names keeps
 * upstream's markup and indentation untouched, so a sync merges as a rename of two tags.
 */
export function upstreamOnly<Component>(component: Component): Component {
  return IRIX_BUILD ? (Hidden as Component) : component;
}

/** Host settings sections Irix does not offer: pairing goes through the relay. */
const HIDDEN_HOST_SECTIONS: ReadonlySet<string> = new Set(["pair-device"]);

export function isHostSectionOffered(section: string): boolean {
  return !(IRIX_BUILD && HIDDEN_HOST_SECTIONS.has(section));
}

// The daemon keeps each usage report for five minutes; asking a little later than that makes
// every poll reach the source instead of re-reading the cache.
const USAGE_POLL_MS = 330_000;

/** How often the sidebar's pinned usage re-reads on its own. Upstream only refreshes on focus. */
export function usageRefetchInterval(): number | false {
  return IRIX_BUILD ? USAGE_POLL_MS : false;
}
