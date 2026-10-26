import type { PluginButtonRegistration, PluginClientContext } from "@getpaseo/plugin/client";
import { Dismissals } from "./client/dismissal.js";
import { OPEN_AGENT_SCREEN_ID, OpenAgentScreen } from "./client/open-agent-screen.js";
import { pillButton } from "./client/pill.js";
import { ContextHintSettings } from "./client/settings-screen.js";
import {
  contextLevel,
  DEFAULT_PREFERENCES,
  usagePercent,
  type HintPreferences,
} from "./shared/level.js";
import { preferencesRpc } from "./shared/preferences.js";

const SETTINGS_ID = "context-hint";
const PILL_ID = "context-hint";
const PREFERENCES_TTL_MS = 5_000;

interface ObservedAgent {
  id: string;
  workspaceId?: string | null;
  parentAgentId?: string | null;
  provider: string;
  model?: string | null;
  currentModeId?: string | null;
  cwd: string;
  lastUsage?: { contextWindowUsedTokens?: number; contextWindowMaxTokens?: number };
}

export default function contribute(client: PluginClientContext) {
  client.addSettingsScreen({
    id: SETTINGS_ID,
    title: "Context hint",
    icon: "Gauge",
    Component: ContextHintSettings,
  });
  const removeOpenAgentScreen = client.addScreen({
    id: OPEN_AGENT_SCREEN_ID,
    title: "Context hint",
    Component: OpenAgentScreen,
  });
  // Settings → Plugins lists only plugins installed from a folder, so a built-in plugin's
  // settings screen has no menu to open it from. This is its entry point.
  const removeSettingsEntry = client.addCommandCenterItem({
    id: "settings",
    title: "Context hint settings",
    icon: "Gauge",
    keywords: ["context", "compact", "threshold", "window", "hint"],
    context: "global",
    onSelect({ openSettings }) {
      openSettings(SETTINGS_ID);
    },
  });

  const lifetime = new AbortController();
  const pills = new Map<string, { registration: PluginButtonRegistration; shown: string }>();
  const dismissals = new Dismissals();
  let stopped = false;
  let cachedPreferences: { at: number; value: HintPreferences } | null = null;

  async function preferences(): Promise<HintPreferences> {
    const now = Date.now();
    if (cachedPreferences && now - cachedPreferences.at < PREFERENCES_TTL_MS) {
      return cachedPreferences.value;
    }
    const value = await client.rpc(preferencesRpc, {}).catch(() => DEFAULT_PREFERENCES);
    cachedPreferences = { at: now, value };
    return value;
  }

  function forget(agentId: string) {
    pills.get(agentId)?.registration.remove();
    pills.delete(agentId);
    dismissals.forget(agentId);
  }

  async function evaluate(agent: ObservedAgent) {
    const workspaceId = agent.workspaceId;
    if (!workspaceId || agent.parentAgentId) return;
    const prefs = await preferences();
    if (stopped) return;
    const percent = usagePercent(
      agent.lastUsage?.contextWindowUsedTokens,
      agent.lastUsage?.contextWindowMaxTokens,
    );
    const rawLevel = contextLevel(percent, prefs);
    const level = dismissals.visibleLevel(agent.id, rawLevel);
    const existing = pills.get(agent.id);
    if (level === "none" || percent === null) {
      if (existing && existing.shown !== "hidden") {
        existing.registration.update({ visible: false });
        existing.shown = "hidden";
      }
      return;
    }
    const shown = `${level}:${percent}`;
    if (existing?.shown === shown) return;
    const button = pillButton(level, percent, {
      compact: () => client.paseo.agents.ref(agent.id).send("/compact"),
      newSession: async () => {
        const created = await client.paseo.workspaces.ref(workspaceId).agents.create({
          config: {
            provider: agent.model ? `${agent.provider}/${agent.model}` : agent.provider,
            ...(agent.currentModeId ? { modeId: agent.currentModeId } : {}),
          },
        });
        client.openScreen({ screenId: OPEN_AGENT_SCREEN_ID, params: { agentId: created.id } });
      },
      dismiss: () => {
        dismissals.dismiss(agent.id, level);
        void evaluate(agent);
      },
    });
    if (existing) {
      existing.registration.update(button);
      existing.shown = shown;
      return;
    }
    const registration = client.addComposerPill({
      id: PILL_ID,
      workspaceId,
      agentId: agent.id,
      button,
    });
    pills.set(agent.id, { registration, shown });
  }

  void client.paseo.agents
    .list({ subscribe: {}, signal: lifetime.signal })
    .then(({ subscription }) => {
      subscription.subscribe({
        snapshot: ({ entries }) => {
          for (const id of pills.keys()) forget(id);
          for (const { agent } of entries) void evaluate(agent);
        },
        update: (message) => {
          if (message.type !== "agent_update") return;
          const update = message.payload;
          if (update.kind === "remove") forget(update.agentId);
          else void evaluate(update.agent);
        },
      });
      return undefined;
    })
    .catch((error) => {
      if (!stopped) console.error("Context hint: agent observation failed", error);
    });

  return () => {
    stopped = true;
    lifetime.abort();
    removeSettingsEntry();
    removeOpenAgentScreen();
    for (const id of pills.keys()) forget(id);
  };
}
