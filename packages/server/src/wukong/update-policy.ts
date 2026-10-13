import { isWukongActive } from "./policy.js";

const SELF_UPDATE_REFUSAL =
  "Wukong does not update itself: that would fetch the upstream Paseo packages from the npm " +
  "registry. Install the new Wukong bundle by hand (windows-update.ps1).";

/** Why the daemon's "Update daemon" is refused, or null where it is allowed (not Wukong). */
export function selfUpdateRefusal(): string | null {
  return isWukongActive() ? SELF_UPDATE_REFUSAL : null;
}
