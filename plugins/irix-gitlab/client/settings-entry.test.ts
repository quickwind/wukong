import type {
  PluginClientContext,
  PluginCommandCenterItemContribution,
  PluginGlobalCommandContext,
} from "@getpaseo/plugin/client";
import { describe, expect, it } from "vitest";
import { GITLAB_SETTINGS_ID, contributeSettingsEntry } from "./settings-entry.js";

describe("contributeSettingsEntry", () => {
  it("adds a global Command Center item that opens the GitLab settings screen", async () => {
    const items: PluginCommandCenterItemContribution[] = [];
    const client = {
      addCommandCenterItem(item: PluginCommandCenterItemContribution) {
        items.push(item);
        return () => items.splice(items.indexOf(item), 1);
      },
    } as unknown as PluginClientContext;

    const remove = contributeSettingsEntry(client);

    expect(items).toHaveLength(1);
    const [item] = items;
    expect(item?.context).toBe("global");
    expect(item?.title).toBe("GitLab settings");
    const opened: string[] = [];
    if (item?.context === "global") {
      await item.onSelect({
        openSettings: (id: string) => opened.push(id),
      } as unknown as PluginGlobalCommandContext);
    }
    expect(opened).toEqual([GITLAB_SETTINGS_ID]);
    remove();
    expect(items).toHaveLength(0);
  });
});
