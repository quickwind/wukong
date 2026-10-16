// The state and actions behind the GitLab setup screen. Plain TypeScript with the RPCs injected, so
// it can be tested without rendering; the screen only draws `getState()` and calls the actions.

import type { RpcOutput } from "@getpaseo/plugin";
import type { setupStatusRpc, setupTestSectionRpc } from "../shared/rpc.js";
import { tokenPageUrl } from "../shared/token-url.js";

export type SetupStatus = RpcOutput<typeof setupStatusRpc>;
export type TestOutcome = RpcOutput<typeof setupTestSectionRpc>;

export interface SetupApi {
  status(): Promise<SetupStatus>;
  testSection(section: string): Promise<TestOutcome>;
  createSection(input: {
    url: string;
    token: string;
    replaceSection?: string;
  }): Promise<{ section: string }>;
  save(input: {
    section: string;
    cloneRoot: string;
  }): Promise<{ url: string; restartNeeded: boolean }>;
  openUrl(url: string): Promise<void>;
}

export interface SetupState {
  loading: boolean;
  loadError: string | null;
  status: SetupStatus | null;
  section: string | null;
  test: { running: boolean; outcome: TestOutcome | null; error: string | null };
  /** The user asked for the new-section form while sections already exist. */
  adding: boolean;
  url: string;
  token: string;
  busy: boolean;
  formError: string | null;
  cloneRoot: string;
  saving: boolean;
  savedResult: { url: string; restartNeeded: boolean } | null;
  saveError: string | null;
}

const NO_TEST = { running: false, outcome: null, error: null } as const;

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export function createSetupController(api: SetupApi) {
  let state: SetupState = {
    loading: true,
    loadError: null,
    status: null,
    section: null,
    test: NO_TEST,
    adding: false,
    url: "",
    token: "",
    busy: false,
    formError: null,
    cloneRoot: "",
    saving: false,
    savedResult: null,
    saveError: null,
  };
  const listeners = new Set<() => void>();

  function set(patch: Partial<SetupState>) {
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  }

  const sectionUrl = (): string | null =>
    state.status?.sections.find((entry) => entry.name === state.section)?.url ?? null;

  async function load() {
    set({ loading: true, loadError: null });
    try {
      const status = await api.status();
      const usable = status.sections.filter((entry) => entry.usable);
      const keep = state.section && usable.some((entry) => entry.name === state.section);
      const saved = status.saved.configSection;
      const section = keep
        ? state.section
        : saved && usable.some((entry) => entry.name === saved)
          ? saved
          : (usable[0]?.name ?? null);
      set({
        loading: false,
        status,
        section,
        cloneRoot: state.status ? state.cloneRoot : (status.saved.cloneRoot ?? status.defaultCloneRoot),
      });
    } catch (error) {
      set({ loading: false, loadError: messageOf(error) });
    }
  }

  async function runTest() {
    const section = state.section;
    if (!section) return;
    set({ test: { running: true, outcome: null, error: null } });
    try {
      const outcome = await api.testSection(section);
      // The user may have chosen another section while GitLab answered.
      if (state.section === section) set({ test: { running: false, outcome, error: null } });
    } catch (error) {
      if (state.section === section) {
        set({ test: { running: false, outcome: null, error: messageOf(error) } });
      }
    }
  }

  async function openTokenPage(target: "new" | "section") {
    const base = target === "new" ? state.url.trim() : sectionUrl();
    if (!base) return;
    try {
      new URL(base);
    } catch {
      set({ formError: "Enter the GitLab URL first, such as https://gitlab.example.com" });
      return;
    }
    set({ formError: null });
    try {
      await api.openUrl(tokenPageUrl(base));
    } catch (error) {
      set({ formError: messageOf(error) });
    }
  }

  /** The token leaves the state before the request starts, so no failure path can keep it. */
  function takeToken(): string {
    const token = state.token;
    set({ token: "" });
    return token;
  }

  async function submitNewSection() {
    set({ busy: true, formError: null });
    const token = takeToken();
    try {
      const { section } = await api.createSection({ url: state.url.trim(), token });
      await load();
      set({ busy: false, adding: false, url: "", section, test: NO_TEST, savedResult: null });
    } catch (error) {
      set({ busy: false, formError: messageOf(error) });
    }
  }

  async function submitRenewedToken() {
    const section = state.section;
    const url = sectionUrl();
    if (!section || !url) return;
    set({ busy: true, formError: null });
    const token = takeToken();
    try {
      await api.createSection({ url, token, replaceSection: section });
      set({ busy: false });
      await runTest();
    } catch (error) {
      set({ busy: false, formError: messageOf(error) });
    }
  }

  async function save() {
    const section = state.section;
    if (!section) return;
    set({ saving: true, saveError: null, savedResult: null });
    try {
      const savedResult = await api.save({ section, cloneRoot: state.cloneRoot });
      set({ saving: false, savedResult });
      await load();
    } catch (error) {
      set({ saving: false, saveError: messageOf(error) });
    }
  }

  return {
    getState: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    load,
    runTest,
    openTokenPage,
    submitNewSection,
    submitRenewedToken,
    save,
    selectSection: (section: string) =>
      set({ section, test: NO_TEST, savedResult: null, formError: null }),
    startAdding: () => set({ adding: true, formError: null }),
    cancelAdding: () => set({ adding: false, token: "", formError: null }),
    setUrl: (url: string) => set({ url }),
    setToken: (token: string) => set({ token }),
    setCloneRoot: (cloneRoot: string) => set({ cloneRoot, savedResult: null }),
    /** The new-section form shows on request, or when there is nothing to choose from. */
    showNewSectionForm: () =>
      state.adding || (state.status !== null && !state.status.sections.some((entry) => entry.usable)),
    /** A rejected token, or one about to expire, calls for a new one. */
    needsNewToken: () =>
      state.test.outcome?.result === "token-rejected" || state.test.outcome?.expiresSoon === true,
  };
}

export type SetupController = ReturnType<typeof createSetupController>;
