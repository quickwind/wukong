import type { ComponentType } from "react";

import { useSessionStore } from "@/stores/session-store";
import { IRIX_BUILD } from "./build";

/** True when a connected daemon reports that it has schedules switched off. */
export function useSchedulesDisabled(): boolean {
  return useSessionStore((state) =>
    IRIX_BUILD
      ? Object.values(state.sessions).some(
          (session) => session?.serverInfo?.features?.schedulesDisabled === true,
        )
      : false,
  );
}

/** Wraps a component so it renders nothing while schedules are switched off. */
export function hideWhenSchedulesDisabled<Props extends object>(
  Component: ComponentType<Props>,
): ComponentType<Props> {
  return function HideWhenSchedulesDisabled(props: Props) {
    const disabled = useSchedulesDisabled();
    return disabled ? null : <Component {...props} />;
  };
}
