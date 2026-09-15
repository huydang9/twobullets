import { MAX_MATCH_PLAYERS, MIN_MATCH_PLAYERS, TEAM_MODES, type TeamMode } from "@twobullets/contracts/match";
import type { CatalogResponse, LobbyView, MatchResultResponse, TicketView } from "@twobullets/contracts/rest";
import type { BotDifficulty } from "@twobullets/shared";
import { getLanguage, LANGUAGES, onLanguageChange, setLanguage, t, type Language, type MessageKey } from "../i18n";
import { el } from "../ui/dom";
import { MapPicker } from "../ui/mapPicker";
import { loadStatsStripEnabled, saveStatsStripEnabled } from "../ui/StatsStrip";
import { loadCreditLines } from "./credits";
import { mapLabel, mapPreviewUrl, unavailableNetworkMaps } from "./maps";
import type { MenuController } from "./MenuController";
import type { MainPanel, MenuState } from "./menuState";
import { DIFFICULTIES, SIZE_PRESETS, type PreferenceStore } from "./preferences";
import { errorMessageKey, normalizeLobbyCode, normalizeNickname } from "./validation";
import "./menu.css";

// DOM for the front door. Each state change rebuilds the current screen (menus are small); inputs keep their drafts
// and focus across rebuilds, the queue timer ticks in place, and the map picker lives on its own layer.

const LANGUAGE_SHORT: Readonly<Record<Language, string>> = { vi: "VI", en: "EN" };
const MODE_KEYS: Readonly<Record<TeamMode, MessageKey>> = { solo: "setup.mode.solo", duo: "setup.mode.duo", squad: "setup.mode.squad" };
const DIFFICULTY_KEYS: Readonly<Record<BotDifficulty, MessageKey>> = { easy: "setup.difficulty.easy", normal: "setup.difficulty.normal", hard: "setup.difficulty.hard" };
const TEAM_SIZE: Readonly<Record<TeamMode, number>> = { solo: 1, duo: 2, squad: 4 };
type GraphicsPreset = "high" | "balanced" | "performance";
const GRAPHICS_PRESETS: readonly GraphicsPreset[] = ["high", "balanced", "performance"];

interface Option<T extends string> {
  readonly value: T;
  readonly label: string;
}

export class MenuView {
  readonly root: HTMLDivElement;
  private readonly frame: HTMLDivElement;
  private readonly layer: HTMLDivElement;
  private picker: MapPicker | null = null;
  private readonly drafts = { nickname: "", invite: "", code: "" };
  private loginPractice = false;
  private credits: string[] | null = null;
  private creditsLoading = false;
  private graphics: GraphicsPreset | null = null;
  private copiedCode: string | null = null;
  private queueRefs: { elapsed: HTMLElement; botsIn: HTMLElement; ticket: TicketView } | null = null;
  private readonly timer: ReturnType<typeof setInterval>;
  private readonly unsubscribe: (() => void)[] = [];
  private readonly controller: MenuController;
  private readonly prefs: PreferenceStore;

  constructor(parent: HTMLElement, controller: MenuController, prefs: PreferenceStore) {
    this.controller = controller;
    this.prefs = prefs;
    this.root = el("div", "tb-menu", undefined, parent);
    this.frame = el("div", "tb-menu__frame", undefined, this.root);
    this.layer = el("div", "tb-menu__layer", undefined, this.root);
    this.drafts.nickname = controller.api.store.lastNickname ?? "";
    this.unsubscribe.push(controller.subscribe((state) => this.render(state)));
    this.unsubscribe.push(onLanguageChange(() => this.render(this.controller.state)));
    this.timer = setInterval(() => this.tick(), 250);
    this.render(controller.state);
  }

  dispose(): void {
    clearInterval(this.timer);
    for (const off of this.unsubscribe) off();
    this.picker?.dispose();
    this.root.remove();
  }

  private rerender(): void {
    this.render(this.controller.state);
  }

  render(state: MenuState): void {
    const screen = state.screen;
    const behindGame = screen.kind === "results" && screen.awaitingGame;
    this.root.hidden = screen.kind === "inGame" || behindGame;
    this.root.dataset.screen = screen.kind;
    if (screen.kind === "results" && screen.fromGame && !behindGame && document.pointerLockElement) document.exitPointerLock();
    if (screen.kind !== "main" && screen.kind !== "lobby" && screen.kind !== "login") this.closePicker();

    const active = document.activeElement instanceof HTMLElement && this.frame.contains(document.activeElement) ? document.activeElement : null;
    const focusKey = active?.dataset.focus ?? null;
    const selection = active instanceof HTMLInputElement && active.type === "text" ? active.selectionStart : null;

    this.queueRefs = null;
    this.frame.replaceChildren();
    this.topBar(state);
    const body = el("main", "tb-menu__body", undefined, this.frame);
    switch (screen.kind) {
      case "boot":
      case "inGame":
        el("div", "tb-menu__status", t("menu.loading"), body);
        break;
      case "login":
        this.login(body, state);
        break;
      case "main":
        this.main(body, state, screen.panel);
        break;
      case "lobby":
        this.lobby(body, state, screen.lobby);
        break;
      case "queue":
        this.queue(body, state, screen.ticket);
        break;
      case "connecting":
        this.connecting(body, state, screen.mapId, screen.reconnect);
        break;
      case "results":
        this.results(body, state, screen.result);
        break;
    }
    this.banners(state);

    if (focusKey) {
      const target = this.frame.querySelector<HTMLElement>(`[data-focus="${focusKey}"]`);
      if (target && !(target as HTMLButtonElement).disabled) {
        target.focus();
        if (target instanceof HTMLInputElement && selection !== null) target.setSelectionRange(selection, selection);
      }
    }
    this.tick();
  }

  // ─── chrome ───────────────────────────────────────────────────────────────────────────────────────────────────────

  private topBar(state: MenuState): void {
    const bar = el("header", "tb-menu__top", undefined, this.frame);
    el("div", "tb-menu__brand", "TWOBULLETS", bar);
    const right = el("div", "tb-menu__top-right", undefined, bar);
    if (state.account) el("div", "tb-menu__account", `${state.account.nickname}#${state.account.tag}`, right);
    const group = el("div", "tb-menu__lang", undefined, right);
    group.setAttribute("role", "radiogroup");
    group.setAttribute("aria-label", t("common.language"));
    for (const code of LANGUAGES) {
      const button = el("button", "tb-menu__lang-option", LANGUAGE_SHORT[code], group);
      button.type = "button";
      button.lang = code;
      button.title = t(`common.languageName.${code}`);
      button.setAttribute("role", "radio");
      button.setAttribute("aria-checked", String(code === getLanguage()));
      button.addEventListener("click", () => this.pickLanguage(code));
    }
  }

  private banners(state: MenuState): void {
    if (state.account && (state.socket === "reconnecting" || state.socket === "replaced") && state.screen.kind !== "login") {
      el("div", "tb-menu__socket", t(state.socket === "replaced" ? "menu.replaced" : "menu.reconnecting"), this.frame);
    }
    if (state.notice && !state.upgradeRequired) {
      const notice = el("div", "tb-menu__notice", undefined, this.frame);
      notice.setAttribute("role", "alert");
      el("span", "tb-menu__notice-text", t(errorMessageKey(state.notice)), notice);
      if (state.notice === "network" && (state.screen.kind === "login" || state.screen.kind === "boot")) {
        this.button(notice, "menu.retry", "tb-menu__link", () => void this.controller.boot());
      }
      this.button(notice, "menu.dismiss", "tb-menu__link", () => this.controller.dismissNotice());
    }
    if (state.upgradeRequired) {
      const overlay = el("div", "tb-menu__upgrade", undefined, this.frame);
      overlay.setAttribute("role", "alertdialog");
      el("div", "tb-menu__upgrade-text", t("error.upgradeRequired"), overlay);
      this.button(overlay, "menu.reload", "tb-menu__primary", () => window.location.reload());
    }
  }

  // ─── login ────────────────────────────────────────────────────────────────────────────────────────────────────────

  private login(body: HTMLElement, state: MenuState): void {
    const panel = el("section", "tb-menu__panel tb-menu__login", undefined, body);
    const title = el("div", "tb-menu__hero", undefined, panel);
    el("h1", "tb-menu__title", "TWOBULLETS", title);
    el("div", "tb-menu__tagline", t("overlay.tagline"), title);

    const form = el("form", "tb-menu__form", undefined, panel);
    const nickname = this.input(form, "login.nickname", "nickname", this.drafts.nickname, (value) => (this.drafts.nickname = value));
    nickname.maxLength = 32;
    nickname.setAttribute("autocomplete", "nickname");
    nickname.spellcheck = false;
    el("div", "tb-menu__hint", t("login.nicknameHint"), form);
    if (state.catalog?.inviteRequired) {
      const invite = this.input(form, "login.invite", "invite", this.drafts.invite, (value) => (this.drafts.invite = value));
      invite.autocomplete = "off";
      invite.spellcheck = false;
    }
    const submit = this.button(form, "login.play", "tb-menu__primary", () => {}, state.busy);
    submit.type = "submit";
    submit.dataset.focus = "login-submit";
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (state.busy) return;
      const name = normalizeNickname(this.drafts.nickname);
      if (name === null) {
        this.controller.dispatch({ type: "failed", code: "nicknameInvalid" });
        return;
      }
      void this.controller.login(name, this.drafts.invite);
    });

    const offline = el("div", "tb-menu__offline", undefined, panel);
    this.button(offline, "menu.practice", "tb-menu__secondary", () => {
      this.loginPractice = !this.loginPractice;
      this.rerender();
    });
    if (this.loginPractice) this.practiceForm(offline);
  }

  // ─── main menu ────────────────────────────────────────────────────────────────────────────────────────────────────

  private main(body: HTMLElement, state: MenuState, panel: MainPanel): void {
    const layout = el("div", "tb-menu__main", undefined, body);
    const nav = el("nav", "tb-menu__nav", undefined, layout);
    const item = (key: MessageKey, current: boolean, onClick: () => void): void => {
      const button = this.button(nav, key, "tb-menu__nav-item", onClick, state.busy);
      if (current) button.setAttribute("aria-current", "true");
    };
    item("menu.quickPlay", panel === "quickPlay", () => this.controller.openPanel("quickPlay"));
    item("menu.createLobby", false, () => void this.controller.createLobby(this.lobbySettings(state.catalog)));
    item("menu.joinByCode", panel === "joinCode", () => this.controller.openPanel("joinCode"));
    item("menu.practice", panel === "practice", () => this.controller.openPanel("practice"));
    el("div", "tb-menu__nav-gap", undefined, nav);
    item("menu.settings", panel === "settings", () => this.controller.openPanel("settings"));
    item("menu.credits", panel === "credits", () => this.controller.openPanel("credits"));
    item("menu.logout", false, () => this.controller.logout());

    const content = el("section", "tb-menu__panel tb-menu__content", undefined, layout);
    if (state.rejoin) {
      const card = el("div", "tb-menu__rejoin", undefined, content);
      const text = el("div", "tb-menu__rejoin-text", undefined, card);
      el("div", "tb-menu__rejoin-title", t("match.rejoinHint"), text);
      el("div", "tb-menu__hint", t("match.mapLine", { map: mapLabel(state.rejoin.settings.mapId, state.catalog) }), text);
      this.button(card, "match.rejoin", "tb-menu__primary", () => this.controller.rejoin(), state.busy);
    }

    switch (panel) {
      case "home": {
        el("h2", "tb-menu__heading", t("menu.homeTitle"), content);
        el("p", "tb-menu__text", t("menu.homeHint"), content);
        if (!state.catalog) el("p", "tb-menu__text tb-menu__warn", t("menu.serverDown"), content);
        const actions = el("div", "tb-menu__actions", undefined, content);
        this.button(actions, "menu.quickPlay", "tb-menu__primary", () => this.controller.openPanel("quickPlay"), state.busy);
        this.button(actions, "menu.createLobby", "tb-menu__secondary", () => void this.controller.createLobby(this.lobbySettings(state.catalog)), state.busy);
        break;
      }
      case "quickPlay": {
        el("h2", "tb-menu__heading", t("menu.quickPlay"), content);
        const p = this.prefs.current;
        this.row(content, "settings.mode", (cell) => this.segmented(cell, this.modeOptions(), p.mode, (mode) => this.savePrefs({ mode }), state.busy));
        this.row(content, "settings.players", (cell) => this.playersControl(cell, "qp-players", p.players, (players) => this.savePrefs({ players }), state.busy));
        this.summary(content, p.mode, p.players);
        const actions = el("div", "tb-menu__actions", undefined, content);
        this.button(actions, "menu.find", "tb-menu__primary", () => void this.controller.quickPlay(this.prefs.current.mode, this.prefs.current.players), state.busy);
        break;
      }
      case "joinCode": {
        el("h2", "tb-menu__heading", t("menu.joinByCode"), content);
        const form = el("form", "tb-menu__form", undefined, content);
        const input = this.input(form, "lobby.code", "join-code", this.drafts.code, (value) => {
          this.drafts.code = value.toUpperCase();
          input.value = this.drafts.code;
          join.disabled = state.busy || normalizeLobbyCode(this.drafts.code) === null;
          hint.textContent = this.drafts.code.length >= 6 && normalizeLobbyCode(this.drafts.code) === null ? t("error.codeInvalid") : t("lobby.codeInput");
        });
        input.maxLength = 6;
        input.autocomplete = "off";
        input.spellcheck = false;
        input.classList.add("tb-menu__code-input");
        const hint = el("div", "tb-menu__hint", t("lobby.codeInput"), form);
        const join = this.button(form, "menu.join", "tb-menu__primary", () => {}, state.busy || normalizeLobbyCode(this.drafts.code) === null);
        join.type = "submit";
        form.addEventListener("submit", (event) => {
          event.preventDefault();
          const code = normalizeLobbyCode(this.drafts.code);
          if (code && !this.controller.state.busy) void this.controller.joinLobby(code);
        });
        break;
      }
      case "practice":
        el("h2", "tb-menu__heading", t("menu.practice"), content);
        this.practiceForm(content);
        break;
      case "settings":
        this.settings(content);
        break;
      case "credits":
        this.creditsPanel(content);
        break;
    }
  }

  private practiceForm(parent: HTMLElement): void {
    const form = el("div", "tb-menu__practice", undefined, parent);
    el("p", "tb-menu__hint", t("menu.practiceHint"), form);
    const p = this.prefs.current;
    this.row(form, "setup.difficulty", (cell) =>
      this.segmented(cell, DIFFICULTIES.map((value) => ({ value, label: t(DIFFICULTY_KEYS[value]) })), p.practiceDifficulty, (practiceDifficulty) => this.savePrefs({ practiceDifficulty })),
    );
    this.row(form, "settings.mode", (cell) => this.segmented(cell, this.modeOptions(), p.practiceMode, (practiceMode) => this.savePrefs({ practiceMode })));
    this.row(form, "settings.players", (cell) => this.playersControl(cell, "practice-players", p.practicePlayers, (practicePlayers) => this.savePrefs({ practicePlayers })));
    this.row(form, "settings.map", (cell) => this.mapCard(cell, p.practiceMapId, null, true, undefined, (practiceMapId) => this.savePrefs({ practiceMapId })));
    const actions = el("div", "tb-menu__actions", undefined, form);
    this.button(actions, "menu.startPractice", "tb-menu__primary", () => {
      const now = this.prefs.current;
      this.controller.practice({ difficulty: now.practiceDifficulty, mode: now.practiceMode, players: now.practicePlayers, mapId: now.practiceMapId });
    });
  }

  private settings(content: HTMLElement): void {
    el("h2", "tb-menu__heading", t("menu.settings"), content);
    this.row(content, "settings.language", (cell) =>
      this.segmented(cell, LANGUAGES.map((value) => ({ value, label: t(`common.languageName.${value}`) })), getLanguage(), (language) => this.pickLanguage(language)),
    );
    this.row(content, "settings.graphics", (cell) => {
      if (this.graphics === null) {
        void import("../perf/graphicsSettings").then(({ loadGraphicsSettings }) => {
          this.graphics = loadGraphicsSettings().preset;
          this.rerender();
        });
        el("span", "tb-menu__hint", t("menu.loading"), cell);
        return;
      }
      this.segmented(cell, GRAPHICS_PRESETS.map((value) => ({ value, label: t(`settings.graphics.${value}`) })), this.graphics, (preset) => {
        this.graphics = preset;
        void import("../perf/graphicsSettings").then(({ loadGraphicsSettings, saveGraphicsSettings }) => saveGraphicsSettings({ ...loadGraphicsSettings(), preset }));
        this.rerender();
      });
      el("div", "tb-menu__hint", t("settings.graphicsHint"), cell);
    });
    this.row(content, "settings.statsStrip", (cell) =>
      this.segmented(cell, [{ value: "on", label: t("settings.on") }, { value: "off", label: t("settings.off") }], loadStatsStripEnabled() ? "on" : "off", (value) => {
        saveStatsStripEnabled(value === "on");
        this.rerender();
      }),
    );
  }

  private creditsPanel(content: HTMLElement): void {
    el("h2", "tb-menu__heading", t("menu.credits"), content);
    el("p", "tb-menu__hint", t("menu.creditsIntro"), content);
    if (this.credits === null) {
      el("p", "tb-menu__hint", t("menu.loading"), content);
      if (!this.creditsLoading) {
        this.creditsLoading = true;
        void loadCreditLines().then((lines) => {
          this.credits = lines;
          this.rerender();
        });
      }
      return;
    }
    const list = el("ul", "tb-menu__credits", undefined, content);
    for (const line of this.credits) el("li", "tb-menu__credit", line, list);
  }

  // ─── lobby ────────────────────────────────────────────────────────────────────────────────────────────────────────

  private lobby(body: HTMLElement, state: MenuState, lobby: LobbyView): void {
    const me = state.account?.id ?? "";
    const host = lobby.members.some((m) => m.accountId === me && m.host);
    const open = lobby.status === "open";
    const editable = host && open && !state.busy;
    const settings = lobby.settings;

    const panel = el("section", "tb-menu__panel tb-menu__lobby", undefined, body);
    const header = el("div", "tb-menu__lobby-header", undefined, panel);
    el("h2", "tb-menu__heading", t("lobby.title"), header);
    const codeBox = el("div", "tb-menu__code", undefined, header);
    el("div", "tb-menu__label", t("lobby.code"), codeBox);
    el("div", "tb-menu__code-value", lobby.code, codeBox);
    this.button(codeBox, this.copiedCode === lobby.code ? "lobby.copied" : "lobby.copy", "tb-menu__link", () => {
      void navigator.clipboard?.writeText(lobby.code).then(() => {
        this.copiedCode = lobby.code;
        this.rerender();
      });
    });
    el("div", "tb-menu__hint", t("lobby.codeHint"), header);

    const grid = el("div", "tb-menu__lobby-grid", undefined, panel);
    const left = el("div", "tb-menu__lobby-settings", undefined, grid);
    this.row(left, "settings.mode", (cell) => this.segmented(cell, this.modeOptions(), settings.mode, (mode) => this.editLobby({ mode }), !editable));
    this.row(left, "settings.players", (cell) =>
      this.playersControl(cell, "lobby-players", settings.maxPlayers, (maxPlayers) => this.editLobby({ maxPlayers }), !editable, Math.max(MIN_MATCH_PLAYERS, lobby.members.length)),
    );
    this.row(left, "settings.map", (cell) => this.mapCard(cell, settings.mapId, state.catalog, editable, unavailableNetworkMaps(state.catalog), (mapId) => this.editLobby({ mapId })));
    this.row(left, "settings.bots", (cell) =>
      this.segmented(cell, [{ value: "on", label: t("settings.on") }, { value: "off", label: t("settings.off") }], settings.fillWithBots ? "on" : "off", (value) => this.editLobby({ fillWithBots: value === "on" }), !editable),
    );
    const facts = el("div", "tb-menu__facts", undefined, left);
    el("span", "", t("settings.teams", { teams: lobby.teamCount, size: lobby.teamSize }), facts);
    el("span", "", t("lobby.players", { count: lobby.members.length, max: settings.maxPlayers }), facts);
    if (lobby.botSlots > 0) el("span", "", t("lobby.bots", { count: lobby.botSlots }), facts);

    const teams = el("div", "tb-menu__teams", undefined, grid);
    const myTeam = lobby.members.find((m) => m.accountId === me)?.teamId ?? -1;
    for (let teamId = 0; teamId < lobby.teamCount; teamId++) {
      const capacity = Math.min(lobby.teamSize, settings.maxPlayers - teamId * lobby.teamSize);
      const members = lobby.members.filter((m) => m.teamId === teamId);
      const team = el("div", "tb-menu__team", undefined, teams);
      if (teamId === myTeam) team.classList.add("tb-menu__team--mine");
      const head = el("div", "tb-menu__team-head", undefined, team);
      el("span", "tb-menu__team-name", t("lobby.team", { n: teamId + 1 }), head);
      if (open && teamId !== myTeam && members.length < capacity) this.button(head, "lobby.switchTeam", "tb-menu__link", () => void this.controller.switchTeam(teamId), state.busy);
      for (const member of members) {
        const seat = el("div", "tb-menu__seat", undefined, team);
        if (member.accountId === me) seat.classList.add("tb-menu__seat--me");
        el("span", "tb-menu__seat-name", member.nickname, seat);
        el("span", "tb-menu__seat-tag", `#${member.tag}`, seat);
        if (member.accountId === me) el("span", "tb-menu__badge", t("common.you"), seat);
        if (member.host) el("span", "tb-menu__badge tb-menu__badge--host", t("lobby.host"), seat);
      }
      for (let i = members.length; i < capacity; i++) {
        el("div", "tb-menu__seat tb-menu__seat--empty", t(settings.fillWithBots ? "lobby.botSeat" : "lobby.emptySeat"), team);
      }
    }

    const footer = el("div", "tb-menu__actions tb-menu__lobby-footer", undefined, panel);
    this.button(footer, "lobby.leave", "tb-menu__secondary", () => void this.controller.leaveLobby(), state.busy || lobby.status === "starting");
    if (lobby.status === "starting") el("div", "tb-menu__status-line", t("lobby.starting"), footer);
    else if (lobby.status === "inMatch") el("div", "tb-menu__status-line", t("lobby.inMatch"), footer);
    else if (!host) el("div", "tb-menu__status-line", t("lobby.waitHost"), footer);
    if (host) this.button(footer, "lobby.start", "tb-menu__primary", () => void this.controller.startLobby(), state.busy || !open);
  }

  private editLobby(patch: Parameters<MenuController["updateLobby"]>[0]): void {
    this.prefs.update({
      ...(patch.mode ? { mode: patch.mode } : {}),
      ...(patch.maxPlayers ? { players: patch.maxPlayers } : {}),
      ...(patch.mapId ? { mapId: patch.mapId } : {}),
      ...(patch.fillWithBots !== undefined ? { fillWithBots: patch.fillWithBots } : {}),
    });
    void this.controller.updateLobby(patch);
  }

  // ─── queue, connecting, results ───────────────────────────────────────────────────────────────────────────────────

  private queue(body: HTMLElement, state: MenuState, ticket: TicketView): void {
    const panel = el("section", "tb-menu__panel tb-menu__center", undefined, body);
    el("div", "tb-menu__pulse", undefined, panel);
    el("h2", "tb-menu__heading", t("queue.searching"), panel);
    const elapsed = el("div", "tb-menu__timer", "0:00", panel);
    el("div", "tb-menu__text", t("queue.summary", { mode: t(MODE_KEYS[ticket.settings.mode]), count: ticket.settings.maxPlayers }), panel);
    el("div", "tb-menu__hint", t("queue.waiting", { count: ticket.playersWaiting }), panel);
    const botsIn = el("div", "tb-menu__hint", "", panel);
    const actions = el("div", "tb-menu__actions", undefined, panel);
    this.button(actions, "queue.cancel", "tb-menu__secondary", () => void this.controller.cancelQueue(), state.busy);
    this.queueRefs = { elapsed, botsIn, ticket };
  }

  private tick(): void {
    const refs = this.queueRefs;
    if (!refs) return;
    const now = Date.now();
    const seconds = Math.max(0, Math.floor((now - refs.ticket.createdAt) / 1000));
    const text = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
    if (refs.elapsed.textContent !== text) refs.elapsed.textContent = text;
    const startsBy = refs.ticket.startsBy;
    const left = startsBy === null ? null : Math.ceil((startsBy - now) / 1000);
    const bots = left === null ? "" : left > 0 ? t("queue.botsIn", { s: left }) : t("queue.startingNow");
    if (refs.botsIn.textContent !== bots) refs.botsIn.textContent = bots;
  }

  private connecting(body: HTMLElement, state: MenuState, mapId: string, reconnect: boolean): void {
    const panel = el("section", "tb-menu__panel tb-menu__center", undefined, body);
    el("div", "tb-menu__pulse", undefined, panel);
    el("h2", "tb-menu__heading", t(reconnect ? "match.reconnect" : "match.connecting"), panel);
    el("div", "tb-menu__text", t("match.mapLine", { map: mapLabel(mapId, state.catalog) }), panel);
    el("div", "tb-menu__hint", t("match.waitServer"), panel);
    el("div", "tb-menu__bar", undefined, panel);
  }

  private results(body: HTMLElement, state: MenuState, result: MatchResultResponse | null): void {
    const panel = el("section", "tb-menu__panel tb-menu__results", undefined, body);
    el("h2", "tb-menu__heading", t("results.title"), panel);
    if (!result) {
      el("div", "tb-menu__hint", t("results.loading"), panel);
    } else {
      const outcome =
        result.outcome === "completed" ? (result.winningTeamId !== null ? t("results.winner", { team: result.winningTeamId + 1 }) : "") : t(result.outcome === "cancelled" ? "results.cancelled" : "results.aborted");
      if (outcome) el("div", "tb-menu__text", outcome, panel);
      const mine = result.participants.find((p) => p.accountId === state.account?.id);
      if (mine) el("div", "tb-menu__place", t("results.yourPlace", { place: mine.placement }), panel);
      const wrap = el("div", "tb-menu__table-wrap", undefined, panel);
      const table = el("table", "tb-menu__table", undefined, wrap);
      const head = el("tr", "", undefined, el("thead", "", undefined, table));
      for (const key of ["results.place", "results.player", "results.kills", "results.knocks", "results.revives", "results.damage"] as const) el("th", "", t(key), head);
      const tbody = el("tbody", "", undefined, table);
      const rows = [...result.participants].sort((a, b) => a.placement - b.placement || b.kills - a.kills);
      for (const p of rows) {
        const row = el("tr", p.accountId === state.account?.id ? "tb-menu__row--me" : "", undefined, tbody);
        el("td", "", `#${p.placement}`, row);
        const name = el("td", "", p.nickname, row);
        if (p.bot) el("span", "tb-menu__badge", t("results.bot"), name);
        el("td", "", String(p.kills), row);
        el("td", "", String(p.knocks), row);
        el("td", "", String(p.revives), row);
        el("td", "", String(Math.round(p.damageDealt)), row);
      }
    }
    const actions = el("div", "tb-menu__actions", undefined, panel);
    this.button(actions, "results.back", "tb-menu__primary", () => this.controller.closeResults());
  }

  // ─── widgets ──────────────────────────────────────────────────────────────────────────────────────────────────────

  private pickLanguage(language: Language): void {
    setLanguage(language);
    void this.controller.saveLanguage(language);
  }

  private savePrefs(patch: Parameters<PreferenceStore["update"]>[0]): void {
    this.prefs.update(patch);
    this.rerender();
  }

  private lobbySettings(catalog: CatalogResponse | null): { mode: TeamMode; maxPlayers: number; mapId: string; fillWithBots: boolean } {
    const p = this.prefs.current;
    const mapId = unavailableNetworkMaps(catalog).has(p.mapId) ? (catalog?.defaultMapId ?? "v1") : p.mapId;
    return { mode: p.mode, maxPlayers: p.players, mapId, fillWithBots: p.fillWithBots };
  }

  private modeOptions(): Option<TeamMode>[] {
    return TEAM_MODES.map((value) => ({ value, label: t(MODE_KEYS[value]) }));
  }

  private summary(parent: HTMLElement, mode: TeamMode, players: number): void {
    el("div", "tb-menu__facts", t("settings.teams", { teams: Math.ceil(players / TEAM_SIZE[mode]), size: TEAM_SIZE[mode] }), parent);
  }

  private button(parent: HTMLElement, key: MessageKey, className: string, onClick: () => void, disabled = false): HTMLButtonElement {
    const button = el("button", className, t(key), parent);
    button.type = "button";
    button.disabled = disabled;
    button.addEventListener("click", onClick);
    return button;
  }

  private input(parent: HTMLElement, label: MessageKey, focus: string, value: string, onInput: (value: string) => void): HTMLInputElement {
    const wrap = el("label", "tb-menu__field", undefined, parent);
    el("span", "tb-menu__label", t(label), wrap);
    const input = el("input", "tb-menu__input", undefined, wrap);
    input.type = "text";
    input.value = value;
    input.dataset.focus = focus;
    input.addEventListener("input", () => onInput(input.value));
    return input;
  }

  private row(parent: HTMLElement, label: MessageKey, fill: (cell: HTMLElement) => void): void {
    const row = el("div", "tb-menu__row", undefined, parent);
    el("div", "tb-menu__label", t(label), row);
    fill(el("div", "tb-menu__cell", undefined, row));
  }

  private segmented<T extends string>(parent: HTMLElement, options: readonly Option<T>[], value: T, onPick: (value: T) => void, disabled = false): void {
    const group = el("div", "tb-menu__segmented", undefined, parent);
    group.setAttribute("role", "radiogroup");
    for (const option of options) {
      const button = el("button", "tb-menu__segment", option.label, group);
      button.type = "button";
      button.disabled = disabled;
      button.setAttribute("role", "radio");
      button.setAttribute("aria-checked", String(option.value === value));
      button.addEventListener("click", () => {
        if (option.value !== value) onPick(option.value);
      });
    }
  }

  /** Presets 10/16/20 plus a 2–20 slider; commits on release. */
  private playersControl(parent: HTMLElement, focus: string, value: number, onCommit: (players: number) => void, disabled = false, min: number = MIN_MATCH_PLAYERS): void {
    const wrap = el("div", "tb-menu__players", undefined, parent);
    const presets = el("div", "tb-menu__segmented", undefined, wrap);
    for (const preset of SIZE_PRESETS) {
      const button = el("button", "tb-menu__segment", String(preset), presets);
      button.type = "button";
      button.disabled = disabled || preset < min;
      button.setAttribute("aria-checked", String(preset === value));
      button.addEventListener("click", () => {
        if (preset !== value) onCommit(preset);
      });
    }
    const slider = el("input", "tb-menu__slider", undefined, wrap);
    slider.type = "range";
    slider.min = String(min);
    slider.max = String(MAX_MATCH_PLAYERS);
    slider.step = "1";
    slider.value = String(value);
    slider.disabled = disabled;
    slider.dataset.focus = focus;
    const readout = el("span", "tb-menu__readout", String(value), wrap);
    slider.addEventListener("input", () => (readout.textContent = slider.value));
    slider.addEventListener("change", () => {
      const next = Number(slider.value);
      if (next !== value) onCommit(next);
    });
  }

  /** `unavailable`: maps shown as "coming soon" in the picker (networked lobbies); undefined offers every map. */
  private mapCard(parent: HTMLElement, mapId: string, catalog: CatalogResponse | null, editable: boolean, unavailable: ReadonlySet<string> | undefined, onPick: (mapId: string) => void): void {
    const card = el("div", "tb-menu__map", undefined, parent);
    const preview = mapPreviewUrl(mapId);
    if (preview) {
      const img = el("img", "tb-menu__map-preview", undefined, card);
      img.src = preview;
      img.alt = "";
      img.draggable = false;
    }
    el("div", "tb-menu__map-name", mapLabel(mapId, catalog), card);
    if (editable) this.button(card, "settings.changeMap", "tb-menu__link", () => this.openPicker(mapId, unavailable, onPick));
  }

  private openPicker(selected: string, unavailable: ReadonlySet<string> | undefined, onPick: (mapId: string) => void): void {
    this.closePicker();
    this.picker = new MapPicker(this.layer, {
      selected,
      ...(unavailable ? { unavailable } : {}),
      onCancel: () => this.closePicker(),
      onConfirm: (id) => {
        this.closePicker();
        if (id !== selected) onPick(id);
      },
    });
    this.picker.root.querySelector<HTMLElement>('[aria-checked="true"]')?.focus();
  }

  private closePicker(): void {
    this.picker?.dispose();
    this.picker = null;
  }
}
