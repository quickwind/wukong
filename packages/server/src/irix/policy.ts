// Switch for the Irix policies that upstream code consults (providers, plugins). Off until
// the daemon starts (see edition.ts), so upstream unit tests keep their upstream behaviour.

let active = false;

export function isIrixActive(): boolean {
  return active;
}

/** Turns the policies on; returns a function that turns them off again (for tests). */
export function activateIrixPolicy(): () => void {
  active = true;
  return () => {
    active = false;
  };
}
