import { getLanguage } from "../i18n";
import { ApiClient } from "../platform/ApiClient";
import { apiBaseUrlFromBuild, apiSocketUrl } from "../platform/apiConfig";
import { LobbySocket } from "../platform/LobbySocket";
import { browserStorage } from "../platform/SessionStore";
import { menuSearch, practiceSearch, type MatchLaunch } from "./launch";
import { MenuController } from "./MenuController";
import { MenuView } from "./MenuView";
import { PreferenceStore } from "./preferences";

export { menuSearch, netGameLaunch, practiceSearch, shouldShowMenu, type MatchLaunch, type PracticeSettings } from "./launch";
export { MenuController } from "./MenuController";
export { INITIAL_MENU_STATE, menuReducer, type MenuEvent, type MenuState } from "./menuState";

export interface StartMenuOptions {
  readonly parent: HTMLElement;
  /** Loads the game module and starts the networked match (main.ts). */
  readonly launchMatch: (launch: MatchLaunch) => Promise<void>;
}

export interface RunningMenu {
  readonly controller: MenuController;
  readonly view: MenuView;
}

/** The front door: login → menu → lobby/queue → connecting → game → results. */
export function startMenu(options: StartMenuOptions): RunningMenu {
  const baseUrl = apiBaseUrlFromBuild();
  const api = new ApiClient({ baseUrl });
  const socket = new LobbySocket({
    url: apiSocketUrl(baseUrl, window.location.origin),
    accessToken: () => api.accessToken(),
    refreshAccess: async () => {
      api.store.dropAccess();
      return (await api.accessToken()) !== null;
    },
  });
  const controller = new MenuController({
    api,
    socket,
    session: browserStorage("session"),
    language: getLanguage,
    launchMatch: options.launchMatch,
    launchPractice: (settings) => window.location.assign(`${window.location.pathname}${practiceSearch(window.location.search, settings)}`),
    reloadToMenu: () => window.location.assign(`${window.location.pathname}${menuSearch(window.location.search)}`),
  });
  const view = new MenuView(options.parent, controller, new PreferenceStore());
  void controller.boot();
  if (import.meta.env.DEV) Object.assign(window, { __twobulletsMenu: { api, socket, controller, view } });
  return { controller, view };
}
