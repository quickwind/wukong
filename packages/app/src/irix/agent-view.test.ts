import { afterEach, describe, expect, it, vi } from "vitest";

const agentPanelLoaded = vi.fn();
vi.mock("@/panels/agent-panel", () => {
  agentPanelLoaded();
  return { AgentPanelContent: () => null };
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  agentPanelLoaded.mockClear();
});

async function load() {
  vi.resetModules();
  return import("./agent-view");
}

describe("plugin ui.AgentView", () => {
  it("is not exported in an upstream build", async () => {
    const ui = await load();
    expect(ui.AgentView).toBeUndefined();
    expect(ui.capabilities).toBeUndefined();
  });

  it("is exported in an Irix build with its capability version", async () => {
    vi.stubEnv("EXPO_PUBLIC_IRIX", "1");
    const ui = await load();
    expect(ui.AgentView).toBeTypeOf("function");
    expect(ui.capabilities).toEqual({ agentView: 1, managedProjectsHidden: 1 });
  });

  it("does not import the conversation screen until it renders", async () => {
    vi.stubEnv("EXPO_PUBLIC_IRIX", "1");
    await load();
    expect(agentPanelLoaded).not.toHaveBeenCalled();
  });

  it("reaches plugins through the client ui runtime", async () => {
    vi.stubEnv("EXPO_PUBLIC_IRIX", "1");
    const runtime = await import("@/plugins/react-native/ui");
    expect(runtime.AgentView).toBeTypeOf("function");
    expect(runtime.capabilities).toEqual({ agentView: 1, managedProjectsHidden: 1 });
  }, 60_000);
});
