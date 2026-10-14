import { isIrixActive } from "./policy.js";

const SELF_UPDATE_REFUSAL =
  "Irix does not update itself: that would fetch the upstream Paseo packages from the npm " +
  "registry. Install the new Irix bundle by hand (windows-update.ps1).";

/** Why the daemon's "Update daemon" is refused, or null where it is allowed (not Irix). */
export function selfUpdateRefusal(): string | null {
  return isIrixActive() ? SELF_UPDATE_REFUSAL : null;
}

export const irixSelfUpdateRefusal = selfUpdateRefusal;
