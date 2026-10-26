import type {
  PluginButton,
  PluginButtonIconProps,
  PluginButtonMenuEntry,
} from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/ui";
import { levelMessage, pillLabel, type ContextLevel } from "../shared/level.js";

export interface PillActions {
  compact(): Promise<void>;
  newSession(): Promise<void>;
  dismiss(): void;
}

function alertIcon(level: Exclude<ContextLevel, "none">) {
  const name = level === "critical" ? "OctagonAlert" : "TriangleAlert";
  return function ContextAlert({ theme, size }: PluginButtonIconProps) {
    const color = level === "critical" ? theme.colors.statusDanger : theme.colors.statusWarning;
    return <Icon name={name} size={size} color={color} />;
  };
}

const ICONS = { warn: alertIcon("warn"), critical: alertIcon("critical") };

export function pillButton(
  level: Exclude<ContextLevel, "none">,
  percent: number,
  actions: PillActions,
): PluginButton {
  const items: PluginButtonMenuEntry[] = [
    {
      kind: "item",
      id: "status",
      title: levelMessage(level, percent),
      icon: ICONS[level],
      disabled: true,
      behavior: { kind: "action", onPress() {} },
    },
    { kind: "separator", id: "status-divider" },
    {
      kind: "item",
      id: "compact",
      title: "Compact: summarize the conversation to free up context",
      icon: "Shrink",
      behavior: { kind: "action", onPress: actions.compact },
    },
    {
      kind: "item",
      id: "new-session",
      title: "New session: start fresh, this chat stays as it is",
      icon: "Plus",
      behavior: { kind: "action", onPress: actions.newSession },
    },
    { kind: "separator", id: "dismiss-divider" },
    {
      kind: "item",
      id: "dismiss",
      title: "Don't remind me again for this session",
      icon: "BellOff",
      behavior: { kind: "action", onPress: actions.dismiss },
    },
  ];
  return {
    title: levelMessage(level, percent),
    icon: ICONS[level],
    label: pillLabel(level, percent),
    visible: true,
    behavior: { kind: "menu", items },
  };
}
