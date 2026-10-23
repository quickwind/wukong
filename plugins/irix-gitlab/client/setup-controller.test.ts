import { describe, expect, it } from "vitest";
import { createSetupController, type SetupApi, type SetupStatus } from "./setup-controller.js";

const CORP = { name: "corp", url: "https://gitlab.corp.example.com", usable: true };

function status(partial: Partial<SetupStatus> = {}): SetupStatus {
  return {
    cfgPath: "/home/me/.python-gitlab.cfg",
    sections: [CORP],
    saved: { url: null, configSection: null, cloneRoot: null },
    overrides: [],
    defaultCloneRoot: "~/workspace/gitlab",
    ...partial,
  };
}

function fakeApi(overrides: Partial<SetupApi> = {}) {
  const calls: { method: string; input?: unknown }[] = [];
  const api: SetupApi = {
    async status() {
      calls.push({ method: "status" });
      return status();
    },
    async testSection(section) {
      calls.push({ method: "testSection", input: section });
      return { result: "ok", detail: null, expiresAt: null, expiresSoon: false, missingScopes: [] };
    },
    async createSection(input) {
      calls.push({ method: "createSection", input });
      return { section: input.replaceSection ?? "irix" };
    },
    async save(input) {
      calls.push({ method: "save", input });
      return { url: CORP.url, restartNeeded: true };
    },
    async openUrl(url) {
      calls.push({ method: "openUrl", input: url });
    },
    ...overrides,
  };
  return { api, calls };
}

describe("setup controller", () => {
  it("loads the status and preselects the saved section, without testing it", async () => {
    const { api, calls } = fakeApi({
      async status() {
        return status({ saved: { url: CORP.url, configSection: "corp", cloneRoot: "~/work" } });
      },
    });
    const controller = createSetupController(api);
    await controller.load();
    expect(controller.getState().section).toBe("corp");
    expect(controller.getState().cloneRoot).toBe("~/work");
    expect(calls.map((c) => c.method)).not.toContain("testSection");
  });

  it("defaults the clone root to the one the daemon suggests and shows the new-section form when there are no sections", async () => {
    const { api } = fakeApi({
      async status() {
        return status({ sections: [] });
      },
    });
    const controller = createSetupController(api);
    await controller.load();
    expect(controller.getState().cloneRoot).toBe("~/workspace/gitlab");
    expect(controller.showNewSectionForm()).toBe(true);
  });

  it("shows the new-section form and no selection when no section is usable", async () => {
    const { api } = fakeApi({
      async status() {
        return status({ sections: [{ name: "work", url: "http://gitlab.local", usable: false }] });
      },
    });
    const controller = createSetupController(api);
    await controller.load();
    expect(controller.getState().section).toBeNull();
    expect(controller.showNewSectionForm()).toBe(true);
  });

  it("drops a test result that arrives after another section was chosen", async () => {
    let release: (outcome: Awaited<ReturnType<SetupApi["testSection"]>>) => void = () => {};
    const { api } = fakeApi({
      async status() {
        return status({
          sections: [CORP, { name: "other", url: "https://o.example.com", usable: true }],
        });
      },
      testSection: () => new Promise((resolve) => (release = resolve)),
    });
    const controller = createSetupController(api);
    await controller.load();
    const pending = controller.runTest();
    controller.selectSection("other");
    release({
      result: "token-rejected",
      detail: "401",
      expiresAt: null,
      expiresSoon: false,
      missingScopes: [],
    });
    await pending;
    expect(controller.getState().test).toEqual({ running: false, outcome: null, error: null });
    expect(controller.needsNewToken()).toBe(false);
  });

  it("tests only when asked and keeps the outcome until another section is chosen", async () => {
    const { api, calls } = fakeApi();
    const controller = createSetupController(api);
    await controller.load();
    await controller.runTest();
    expect(controller.getState().test.outcome?.result).toBe("ok");
    expect(calls.filter((c) => c.method === "testSection")).toHaveLength(1);
    controller.selectSection("corp");
    expect(controller.getState().test.outcome).toBeNull();
  });

  it("asks for a new token when the test is rejected or the expiry is near", async () => {
    const rejected = createSetupController(
      fakeApi({
        async testSection() {
          return {
            result: "token-rejected",
            detail: "401",
            expiresAt: null,
            expiresSoon: false,
            missingScopes: [],
          };
        },
      }).api,
    );
    await rejected.load();
    await rejected.runTest();
    expect(rejected.needsNewToken()).toBe(true);

    const soon = createSetupController(
      fakeApi({
        async testSection() {
          return {
            result: "ok",
            detail: null,
            expiresAt: "2026-10-20",
            expiresSoon: true,
            missingScopes: [],
          };
        },
      }).api,
    );
    await soon.load();
    await soon.runTest();
    expect(soon.needsNewToken()).toBe(true);
  });

  it("opens the prefilled token page for a typed url and for the selected section", async () => {
    const { api, calls } = fakeApi();
    const controller = createSetupController(api);
    await controller.load();
    controller.setUrl("https://typed.example.com/");
    await controller.openTokenPage("new");
    await controller.openTokenPage("section");
    const urls = calls.filter((c) => c.method === "openUrl").map((c) => String(c.input));
    expect(urls[0]).toMatch(
      /^https:\/\/typed\.example\.com\/-\/user_settings\/personal_access_tokens\?name=Irix/,
    );
    expect(urls[1]).toMatch(/^https:\/\/gitlab\.corp\.example\.com\/-\/user_settings/);
  });

  it("creates a section, forgets the token at once and selects the new section", async () => {
    let created = false;
    const { api, calls } = fakeApi({
      async status() {
        return status({
          sections: created
            ? [CORP, { name: "irix", url: "https://new.example.com", usable: true }]
            : [],
        });
      },
      async createSection(input) {
        created = true;
        calls.push({ method: "createSection", input });
        return { section: "irix" };
      },
    });
    const controller = createSetupController(api);
    await controller.load();
    controller.setUrl("https://new.example.com");
    controller.setToken("glpat-secret");
    await controller.submitNewSection();
    expect(JSON.stringify(controller.getState())).not.toContain("glpat-secret");
    expect(controller.getState().section).toBe("irix");
    expect(controller.showNewSectionForm()).toBe(false);
  });

  it("shows the error and keeps the form when the token is refused", async () => {
    const { api } = fakeApi({
      async createSection() {
        throw new Error("GitLab rejected the token.");
      },
    });
    const controller = createSetupController(api);
    await controller.load();
    controller.startAdding();
    controller.setUrl("https://new.example.com");
    controller.setToken("nope");
    await controller.submitNewSection();
    expect(controller.getState().formError).toMatch(/rejected/);
    expect(controller.getState().adding).toBe(true);
    expect(JSON.stringify(controller.getState())).not.toContain("nope");
  });

  it("replaces the token of the selected section and tests again", async () => {
    const { api, calls } = fakeApi();
    const controller = createSetupController(api);
    await controller.load();
    controller.setToken("glpat-new");
    await controller.submitRenewedToken();
    expect(calls.find((c) => c.method === "createSection")?.input).toEqual({
      url: CORP.url,
      token: "glpat-new",
      replaceSection: "corp",
    });
    expect(calls.filter((c) => c.method === "testSection")).toHaveLength(1);
    expect(JSON.stringify(controller.getState())).not.toContain("glpat-new");
  });

  it("saves the section and clone root and reports a needed restart", async () => {
    const { api, calls } = fakeApi();
    const controller = createSetupController(api);
    await controller.load();
    controller.setCloneRoot("~/code");
    await controller.save();
    expect(calls.find((c) => c.method === "save")?.input).toEqual({
      section: "corp",
      cloneRoot: "~/code",
    });
    expect(controller.getState().savedResult?.restartNeeded).toBe(true);
  });

  it("reports a load failure", async () => {
    const controller = createSetupController(
      fakeApi({
        async status() {
          throw new Error("daemon unreachable");
        },
      }).api,
    );
    await controller.load();
    expect(controller.getState().loadError).toBe("daemon unreachable");
  });
});
