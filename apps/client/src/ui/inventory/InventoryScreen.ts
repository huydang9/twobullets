import type { Observer } from "@babylonjs/core";
import {
  ITEM_IDS,
  ITEMS,
  THROWABLE_KINDS,
  WEAPONS,
  ammoForWeapon,
  armorCondition,
  countItem,
  isStackItem,
  weaponItemId,
  type ArmorLevel,
  type ArmorSlot,
  type BackpackItemId,
  type InventoryState,
  type ItemId,
  type LootItem,
  type StackItemId,
  type ThrowableKind,
  type WeaponSlot,
} from "@twobullets/shared";
import type { EquipmentItemActions, EquipmentItemsView, ItemEvent } from "../../equipment/types";
import { onLanguageChange, t, type MessageKey } from "../../i18n";
import { KEY_BINDINGS } from "../../input/bindings";
import { setText } from "../anim";
import { el, elT, textNode } from "../dom";
import { inventoryErrorText, itemName, itemSummary, itemTooltip, type ItemTooltip } from "../equipment/labels";
import { ItemIcons, type ItemIconSource } from "./icons";
import "./inventory.css";

/** The parts of InputManager the screen needs: pointer lock state and re-locking on close. */
export interface InventoryInput {
  readonly isLocked: boolean;
  requestLock(): void;
  onLockChange(listener: (locked: boolean) => void): void;
}

export interface InventoryScreenOptions {
  /** Models for the item icons (baked at load from the real 3D models). Without it the screen shows SVG silhouettes. */
  readonly icons?: ItemIconSource | null;
}

type Equipment = EquipmentItemsView & EquipmentItemActions;

/** What is being dragged. */
type DragSource =
  | { readonly kind: "ground"; readonly item: LootItem }
  | { readonly kind: "stack"; readonly itemId: StackItemId }
  | { readonly kind: "weapon"; readonly slot: WeaponSlot }
  | { readonly kind: "armor"; readonly slot: ArmorSlot }
  | { readonly kind: "backpack" };

const STACK_IDS = ITEM_IDS.filter(isStackItem);
const BAG_GROUPS = [
  { title: "inv.group.ammo", categories: ["ammo"] },
  { title: "inv.group.throwables", categories: ["throwable"] },
  { title: "inv.group.healing", categories: ["heal"] },
  { title: "inv.group.boosts", categories: ["boost"] },
] as const satisfies readonly { readonly title: MessageKey; readonly categories: readonly string[] }[];
const WEAPON_SLOT_LABELS = ["inv.slot.primary1", "inv.slot.primary2", "inv.slot.sidearm"] as const satisfies readonly MessageKey[];
const GEAR_SLOTS = ["helmet", "vest", "backpack"] as const;
type GearSlot = (typeof GEAR_SLOTS)[number];
const ATTACHMENT_SLOTS = ["inv.attachment.muzzle", "inv.attachment.grip", "inv.attachment.magazine", "inv.attachment.scope"] as const satisfies readonly MessageKey[];
const NOTICE_MS = 1800;
const AUTO_PICKUP_STORAGE_KEY = "twobullets.autoPickup";
const TOOLTIP_LINES = 5;

/** An <img> showing one item's icon; refreshed when the icon cache changes. */
interface IconSlot {
  readonly img: HTMLImageElement;
  itemId: ItemId | null;
  src: string;
}

interface RowView {
  readonly node: HTMLDivElement;
  readonly icon: IconSlot;
  readonly name: Text;
  readonly sub: Text;
  readonly qty: Text;
  shown: string;
}

interface WeaponCard {
  readonly node: HTMLDivElement;
  readonly icon: IconSlot;
  readonly name: Text;
  readonly magazine: Text;
  readonly reserve: Text;
  readonly caliber: Text;
  shown: string;
}

interface GearCell {
  readonly node: HTMLDivElement;
  readonly icon: IconSlot;
  readonly level: Text;
  readonly detail: Text;
  readonly bar: HTMLDivElement;
  shown: string;
}

interface ThrowableChip {
  readonly node: HTMLDivElement;
  readonly count: Text;
  shown: string;
}

/**
 * PUBG-style inventory (Tab): vicinity | bag (capacity bar, rows grouped by category) | equipment (weapon cards with
 * their picture and ammo, helmet/vest/backpack with level and durability, throwables). Every item shows a picture baked
 * from its 3D model (`ItemIcons`). Drag between columns to pick up, equip, swap or drop; right-click to use, select,
 * equip or drop; Shift/Ctrl+drag a stack onto the vicinity to drop part of it; hover for details. Opening releases the
 * pointer (the game keeps running, look input stops); closing asks for the lock again, otherwise the play overlay's
 * click does it.
 *
 * DOM is built once. While open, each frame compares the inventory object, a signature of the vicinity list and the
 * icon cache version, and rewrites only what changed. Icons bake in `update` even while closed, so Tab never waits.
 */
export class InventoryScreen {
  /** Item pictures; DEV: `__twobullets.inventory.icons.rebake()`. */
  readonly icons: ItemIcons;

  private readonly root: HTMLDivElement;
  private readonly nearbyList: HTMLDivElement;
  private readonly nearbyEmpty: HTMLDivElement;
  private readonly nearbyCount: Text;
  private readonly nearbyRows: (RowView & { item: LootItem | null })[] = [];
  private readonly bagRows = new Map<StackItemId, RowView>();
  private readonly bagGroups: { readonly node: HTMLDivElement; readonly ids: readonly StackItemId[] }[] = [];
  private readonly bagEmpty: HTMLDivElement;
  private readonly capacityUsed: Text;
  private readonly capacityMax: Text;
  private readonly capacityFill: HTMLDivElement;
  private readonly weaponCards: WeaponCard[] = [];
  private readonly gear: Record<GearSlot, GearCell>;
  private readonly throwables = new Map<ThrowableKind, ThrowableChip>();
  private readonly iconSlots: IconSlot[] = [];
  private readonly notice: HTMLDivElement;
  private readonly noticeText: Text;
  private readonly splitter: HTMLDivElement;
  private readonly splitRange: HTMLInputElement;
  private readonly splitNumber: HTMLInputElement;
  private readonly splitTitle: Text;
  private readonly tip: HTMLDivElement;
  private readonly tipTitle: Text;
  private readonly tipLines: { readonly node: HTMLDivElement; readonly text: Text }[] = [];
  private readonly autoPickup: HTMLInputElement;
  private readonly itemObserver: Observer<ItemEvent>;
  private readonly events = new AbortController();
  private readonly unsubscribeLanguage: () => void;
  private readonly attachmentTitles: [HTMLDivElement, MessageKey][] = [];

  private open = false;
  private dragging: DragSource | null = null;
  private splitting: StackItemId | null = null;
  private shownInventory: InventoryState | null = null;
  private shownNearby = "";
  private shownIcons = -1;
  private noticeTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    parent: HTMLElement,
    private readonly equipment: Equipment,
    private readonly input: InventoryInput,
    options: InventoryScreenOptions = {},
  ) {
    this.icons = new ItemIcons(options.icons ?? null);
    // Inside the HUD layer so the --tb-* tokens apply; the stylesheet hides the play overlay while this is open.
    const host = parent.querySelector<HTMLElement>(".tb-hud") ?? parent;
    this.root = el("div", "tb-inv", undefined, host);
    this.root.hidden = true;
    const panel = el("div", "tb-inv__panel", undefined, this.root);

    // ---- Vicinity
    const nearby = this.column(panel, "tb-inv__col tb-inv__col--nearby", "inv.vicinity");
    this.nearbyCount = textNode(el("span", "tb-inv__title-count", undefined, nearby.firstElementChild as HTMLElement));
    this.nearbyList = el("div", "tb-inv__list", undefined, nearby);
    this.nearbyEmpty = elT("div", "tb-inv__empty", "inv.nothingNearby", this.nearbyList);
    this.dropZone(nearby, (source, event) => this.dropToGround(source, event.ctrlKey || event.shiftKey));

    // ---- Bag
    const bag = this.column(panel, "tb-inv__col tb-inv__col--bag", "inv.bag");
    const capacity = el("div", "tb-inv__capacity", undefined, bag);
    const capacityHead = el("div", "tb-inv__capacity-head", undefined, capacity);
    elT("span", "tb-inv__label", "inv.capacity", capacityHead);
    const capacityText = el("span", "tb-inv__capacity-text", undefined, capacityHead);
    this.capacityUsed = textNode(el("span", "tb-inv__capacity-used", undefined, capacityText));
    this.capacityMax = textNode(el("span", "tb-inv__capacity-max", undefined, capacityText));
    const bar = el("div", "tb-inv__bar tb-inv__bar--capacity", undefined, capacity);
    this.capacityFill = el("div", "tb-inv__bar-fill", undefined, bar);
    const bagList = el("div", "tb-inv__list", undefined, bag);
    this.bagEmpty = elT("div", "tb-inv__empty", "inv.bagEmpty", bagList);
    for (const group of BAG_GROUPS) {
      const node = el("div", "tb-inv__group", undefined, bagList);
      elT("div", "tb-inv__group-title", group.title, node);
      const ids = STACK_IDS.filter((id) => (group.categories as readonly string[]).includes(ITEMS[id].category));
      for (const itemId of ids) {
        const row = this.row(node);
        row.node.hidden = true;
        this.draggable(row.node, () => ({ kind: "stack", itemId }), row.icon.img);
        row.node.addEventListener("contextmenu", (event) => {
          event.preventDefault();
          this.stackContext(itemId);
        });
        this.tooltip(row.node, () => itemTooltip(itemId));
        this.bagRows.set(itemId, row);
      }
      this.bagGroups.push({ node, ids });
    }
    this.dropZone(bag, (source) => {
      if (source.kind === "ground") this.equipment.pickUp(source.item.lootId);
    });

    // ---- Equipment
    const gearCol = this.column(panel, "tb-inv__col tb-inv__col--gear", "inv.equipment");
    const weapons = el("div", "tb-inv__weapons", undefined, gearCol);
    WEAPON_SLOT_LABELS.forEach((label, index) => {
      const slot = index as WeaponSlot;
      const node = el("div", "tb-inv__weapon", undefined, weapons);
      const head = el("div", "tb-inv__weapon-head", undefined, node);
      el("span", "tb-key", String(index + 1), head);
      elT("span", "tb-inv__label", label, head);
      const name = textNode(el("span", "tb-inv__weapon-name", undefined, head));
      const body = el("div", "tb-inv__weapon-body", undefined, node);
      const art = el("div", "tb-inv__weapon-art", undefined, body);
      const icon = this.iconSlot(art);
      const ammo = el("div", "tb-inv__weapon-ammo", undefined, body);
      const magazine = textNode(el("span", "tb-inv__weapon-mag", undefined, ammo));
      const reserve = textNode(el("span", "tb-inv__weapon-reserve", undefined, ammo));
      const caliber = textNode(el("span", "tb-inv__weapon-caliber", undefined, ammo));
      const attachments = el("div", "tb-inv__attachments", undefined, node);
      for (const attachment of ATTACHMENT_SLOTS) this.attachmentTitles.push([el("div", "tb-inv__attachment", undefined, attachments), attachment]);
      this.draggable(node, () => (this.equipment.inventory.weapons[slot] ? { kind: "weapon", slot } : null), icon.img);
      node.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        if (this.equipment.inventory.weapons[slot]) this.equipment.drop({ kind: "weapon", slot });
      });
      this.tooltip(node, () => {
        const weapon = this.equipment.inventory.weapons[slot];
        return weapon ? itemTooltip(weaponItemId(weapon.weaponId)) : null;
      });
      this.dropZone(node, (source) => this.dropOnWeaponSlot(source, slot));
      this.weaponCards.push({ node, icon, name, magazine, reserve, caliber, shown: "" });
    });

    const gearRow = el("div", "tb-inv__gear", undefined, gearCol);
    const gearCell = (key: GearSlot, label: MessageKey): GearCell => {
      const node = el("div", "tb-inv__cell", undefined, gearRow);
      const head = el("div", "tb-inv__cell-head", undefined, node);
      elT("span", "tb-inv__label", label, head);
      const level = textNode(el("span", "tb-inv__cell-level", undefined, head));
      const icon = this.iconSlot(el("div", "tb-inv__icon tb-inv__icon--gear", undefined, node));
      const barNode = el("div", "tb-inv__bar tb-inv__bar--thin", undefined, node);
      const fill = el("div", "tb-inv__bar-fill", undefined, barNode);
      const detail = textNode(el("div", "tb-inv__cell-detail", undefined, node));
      const source = (): DragSource | null => {
        const inventory = this.equipment.inventory;
        if (key === "backpack") return inventory.backpack > 0 ? { kind: "backpack" } : null;
        return inventory[key] ? { kind: "armor", slot: key } : null;
      };
      this.draggable(node, source, icon.img);
      node.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        const drag = source();
        if (drag) this.dropToGround(drag, false);
      });
      this.tooltip(node, () => {
        const inventory = this.equipment.inventory;
        if (key === "backpack") return inventory.backpack > 0 ? itemTooltip(backpackItemId(inventory.backpack)) : null;
        const piece = inventory[key];
        return piece ? itemTooltip(`${key}_${piece.level}`, piece.durability) : null;
      });
      return { node, icon, level, detail, bar: fill, shown: "" };
    };
    this.gear = { helmet: gearCell("helmet", "inv.gear.helmet"), vest: gearCell("vest", "inv.gear.vest"), backpack: gearCell("backpack", "inv.gear.backpack") };

    const throwRow = el("div", "tb-inv__throwables", undefined, gearCol);
    el("span", "tb-key", "5", throwRow);
    for (const kind of THROWABLE_KINDS) {
      const node = el("div", "tb-inv__chip", undefined, throwRow);
      const icon = this.iconSlot(el("div", "tb-inv__chip-icon", undefined, node));
      this.setIcon(icon, kind);
      const count = textNode(el("span", "tb-inv__chip-count", undefined, node));
      node.addEventListener("click", () => this.equipment.selectThrowable(kind));
      node.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        this.equipment.selectThrowable(kind);
      });
      this.tooltip(node, () => itemTooltip(kind));
      this.throwables.set(kind, { node, count, shown: "" });
    }
    this.dropZone(gearCol, (source) => {
      if (source.kind === "ground") this.equipment.pickUp(source.item.lootId);
    });

    // ---- Footer: hints, auto pickup, notices.
    const footer = el("div", "tb-inv__footer", undefined, this.root);
    const hints = el("div", "tb-inv__hints", undefined, footer);
    for (const [key, text] of [
      ["inv.hint.drag", "inv.hint.dragAction"],
      ["inv.hint.rightClick", "inv.hint.rightClickAction"],
      ["inv.hint.shiftDrag", "inv.hint.shiftDragAction"],
      ["inv.hint.tab", "inv.hint.tabAction"],
    ] as const) {
      const hint = el("span", "tb-inv__hint", undefined, hints);
      elT("span", "tb-key", key, hint);
      elT("span", "", text, hint);
    }
    const toggle = el("label", "tb-inv__toggle", undefined, footer);
    this.autoPickup = el("input", "", undefined, toggle);
    this.autoPickup.type = "checkbox";
    elT("span", "", "inv.autoPickup", toggle);
    this.equipment.autoPickup = readAutoPickup(this.equipment.autoPickup);
    this.autoPickup.checked = this.equipment.autoPickup;
    this.autoPickup.addEventListener("change", () => {
      this.equipment.autoPickup = this.autoPickup.checked;
      writeAutoPickup(this.autoPickup.checked);
    });
    this.notice = el("div", "tb-inv__notice", undefined, this.root);
    this.noticeText = textNode(this.notice);
    this.notice.hidden = true;

    // ---- Tooltip
    this.tip = el("div", "tb-inv__tip", undefined, this.root);
    this.tip.hidden = true;
    this.tipTitle = textNode(el("div", "tb-inv__tip-title", undefined, this.tip));
    for (let i = 0; i < TOOLTIP_LINES; i++) {
      const node = el("div", "tb-inv__tip-line", undefined, this.tip);
      this.tipLines.push({ node, text: textNode(node) });
    }

    // ---- Stack split popover.
    this.splitter = el("div", "tb-inv__split", undefined, this.root);
    this.splitter.hidden = true;
    this.splitTitle = textNode(el("div", "tb-inv__split-title", undefined, this.splitter));
    const controls = el("div", "tb-inv__split-controls", undefined, this.splitter);
    this.splitRange = el("input", "tb-inv__split-range", undefined, controls);
    this.splitRange.type = "range";
    this.splitNumber = el("input", "tb-inv__split-number", undefined, controls);
    this.splitNumber.type = "number";
    this.splitRange.addEventListener("input", () => (this.splitNumber.value = this.splitRange.value));
    this.splitNumber.addEventListener("input", () => (this.splitRange.value = this.splitNumber.value));
    const buttons = el("div", "tb-inv__split-buttons", undefined, this.splitter);
    elT("button", "tb-inv__button", "inv.drop", buttons).addEventListener("click", () => this.confirmSplit());
    elT("button", "tb-inv__button tb-inv__button--quiet", "inv.cancel", buttons).addEventListener("click", () => this.closeSplit());
    this.splitter.addEventListener("keydown", (event) => {
      if (event.code === "Enter") this.confirmSplit();
    });

    // Keep the canvas from grabbing the mouse and the browser menu from opening while the screen is up.
    this.root.addEventListener("contextmenu", (event) => event.preventDefault());
    window.addEventListener("keydown", this.handleKey, { capture: true, signal: this.events.signal });
    input.onLockChange((locked) => {
      if (locked && this.open) this.setOpen(false);
    });
    this.itemObserver = equipment.onItem.add(this.handleItemEvent);
    // Bound labels translate themselves; cached rows, cards and cells rewrite on the next render.
    this.setAttachmentTitles();
    this.unsubscribeLanguage = onLanguageChange(() => {
      this.setAttachmentTitles();
      this.shownInventory = null;
      this.shownNearby = "";
      for (const row of [...this.bagRows.values(), ...this.nearbyRows]) row.shown = "";
      for (const card of this.weaponCards) card.shown = "";
      for (const cell of Object.values(this.gear)) cell.shown = "";
      this.closeSplit();
      this.hideTip();
    });
  }

  get isOpen(): boolean {
    return this.open;
  }

  /** Opens or closes the screen (Tab does this itself). */
  setOpen(open: boolean): void {
    if (open === this.open) return;
    this.open = open;
    this.root.hidden = !open;
    this.closeSplit();
    this.hideTip();
    if (open) {
      this.shownInventory = null;
      this.shownNearby = "";
      if (this.input.isLocked) document.exitPointerLock();
      this.update();
    } else {
      this.dragging = null;
      // Keydown is a user gesture, so this usually re-locks at once; if refused, the play overlay's click does.
      if (!this.input.isLocked) this.input.requestLock();
    }
  }

  /** Per render frame, after the scene rendered (icons bake here); cheap when closed or unchanged. */
  update(): void {
    this.icons.step();
    if (!this.open) return;
    const inventory = this.equipment.inventory;
    if (inventory !== this.shownInventory) {
      this.shownInventory = inventory;
      this.renderInventory(inventory);
    }
    const nearby = this.equipment.nearbyLoot;
    let signature = "";
    for (const item of nearby) signature += `${item.lootId}:${item.quantity},`;
    if (signature !== this.shownNearby) {
      this.shownNearby = signature;
      this.renderNearby(nearby);
    }
    if (this.icons.version !== this.shownIcons) {
      this.shownIcons = this.icons.version;
      for (const slot of this.iconSlots) this.setIcon(slot, slot.itemId);
    }
  }

  dispose(): void {
    this.events.abort();
    this.unsubscribeLanguage();
    this.itemObserver.remove();
    clearTimeout(this.noticeTimer);
    this.icons.dispose();
    this.root.remove();
  }

  // ---- Rendering -----------------------------------------------------------------------------------------------------

  private renderInventory(inventory: InventoryState): void {
    const { used, max } = this.equipment.capacity;
    setText(this.capacityUsed, formatWeight(used));
    setText(this.capacityMax, ` / ${max}`);
    const ratio = Math.min(1, max > 0 ? used / max : 0);
    this.capacityFill.style.transform = `scaleX(${ratio})`;
    this.capacityFill.toggleAttribute("data-full", used >= max);
    this.capacityFill.toggleAttribute("data-high", ratio >= 0.85 && used < max);

    let any = false;
    for (const group of this.bagGroups) {
      let groupAny = false;
      for (const itemId of group.ids) {
        const row = this.bagRows.get(itemId)!;
        const quantity = countItem(inventory, itemId);
        row.node.hidden = quantity === 0;
        if (quantity === 0) continue;
        groupAny = true;
        const def = ITEMS[itemId];
        const selected = def.category === "throwable" && inventory.selectedThrowable === def.id;
        row.node.toggleAttribute("data-selected", selected);
        this.updateRow(row, itemId, itemName(itemId), selected ? t("inv.selected", { summary: itemSummary(itemId) }) : itemSummary(itemId), def.category === "ammo" ? `${quantity}` : `×${quantity}`);
      }
      group.node.hidden = !groupAny;
      any ||= groupAny;
    }
    this.bagEmpty.hidden = any;

    inventory.weapons.forEach((weapon, index) => {
      const card = this.weaponCards[index]!;
      const reserve = weapon ? countItem(inventory, ammoForWeapon(weapon.weaponId)) : 0;
      const key = weapon ? `${weapon.weaponId}:${weapon.magazine}:${reserve}` : "";
      if (key === card.shown) return;
      card.shown = key;
      card.node.toggleAttribute("data-empty", !weapon);
      if (!weapon) {
        setText(card.name, t("inv.empty"));
        setText(card.magazine, "");
        setText(card.reserve, "");
        setText(card.caliber, "");
        this.setIcon(card.icon, null);
        return;
      }
      const def = WEAPONS[weapon.weaponId];
      setText(card.name, def.name);
      setText(card.magazine, `${weapon.magazine}`);
      setText(card.reserve, ` / ${reserve}`);
      setText(card.caliber, itemName(ammoForWeapon(weapon.weaponId)));
      card.magazine.parentElement?.toggleAttribute("data-empty", weapon.magazine === 0);
      this.setIcon(card.icon, weaponItemId(weapon.weaponId));
    });

    for (const slot of ["helmet", "vest"] as const) {
      const piece = inventory[slot];
      const condition = piece ? armorCondition(slot, piece) : null;
      this.updateGear(this.gear[slot], piece ? `${slot}_${piece.level}` : null, piece?.level ?? 0, condition, condition === null ? "" : `${Math.round(condition * 100)}%`);
    }
    const pack = inventory.backpack;
    this.updateGear(this.gear.backpack, pack > 0 ? backpackItemId(pack) : null, pack, null, pack > 0 ? `+${ITEMS[backpackItemId(pack)].capacity}` : "");

    for (const [kind, chip] of this.throwables) {
      const count = countItem(inventory, kind);
      const key = `${count}:${inventory.selectedThrowable === kind}`;
      if (key === chip.shown) continue;
      chip.shown = key;
      setText(chip.count, count > 0 ? `${count}` : "0");
      chip.node.toggleAttribute("data-empty", count === 0);
      chip.node.toggleAttribute("data-selected", inventory.selectedThrowable === kind);
    }
  }

  private renderNearby(items: readonly LootItem[]): void {
    while (this.nearbyRows.length < items.length) {
      const row = { ...this.row(this.nearbyList), item: null as LootItem | null };
      this.draggable(row.node, () => (row.item ? { kind: "ground", item: row.item } : null), row.icon.img);
      row.node.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        if (row.item) this.equipment.pickUp(row.item.lootId);
      });
      this.tooltip(row.node, () => (row.item ? itemTooltip(row.item.itemId, row.item.durability) : null));
      this.nearbyRows.push(row);
    }
    this.nearbyRows.forEach((row, index) => {
      const item = items[index] ?? null;
      row.item = item;
      row.node.hidden = item === null;
      if (item) this.updateRow(row, item.itemId, itemName(item.itemId), groundSummary(item), groundQuantity(item), `${item.lootId}:${item.quantity}:${item.durability ?? ""}:${item.magazine ?? ""}`);
    });
    this.nearbyEmpty.hidden = items.length > 0;
    setText(this.nearbyCount, items.length > 0 ? `${items.length}` : "");
  }

  private updateRow(row: RowView, itemId: ItemId, name: string, sub: string, qty: string, key = `${itemId}:${sub}:${qty}`): void {
    if (key === row.shown) return;
    row.shown = key;
    setText(row.name, name);
    setText(row.sub, sub);
    setText(row.qty, qty);
    row.node.toggleAttribute("data-wide", ITEMS[itemId].category === "weapon");
    row.node.dataset.category = ITEMS[itemId].category;
    this.setIcon(row.icon, itemId);
  }

  private updateGear(cell: GearCell, itemId: ItemId | null, level: number, condition: number | null, detail: string): void {
    const key = `${itemId ?? ""}:${condition === null ? "" : condition.toFixed(2)}`;
    if (key === cell.shown) return;
    cell.shown = key;
    setText(cell.level, itemId ? t("inv.level", { level }) : "");
    setText(cell.detail, itemId ? detail : t("inv.empty"));
    cell.node.toggleAttribute("data-empty", !itemId);
    if (itemId) cell.node.dataset.level = String(level);
    else delete cell.node.dataset.level;
    cell.bar.parentElement!.hidden = condition === null;
    if (condition !== null) {
      cell.bar.style.transform = `scaleX(${condition})`;
      cell.bar.toggleAttribute("data-low", condition < 0.3);
    }
    this.setIcon(cell.icon, itemId);
  }

  private setAttachmentTitles(): void {
    for (const [node, key] of this.attachmentTitles) node.title = t("inv.attachmentSoon", { slot: t(key) });
  }

  private setIcon(slot: IconSlot, itemId: ItemId | null): void {
    slot.itemId = itemId;
    const src = itemId ? this.icons.url(itemId) : "";
    slot.img.hidden = !itemId;
    if (src === slot.src) return;
    slot.src = src;
    if (src) slot.img.src = src;
    else slot.img.removeAttribute("src");
  }

  // ---- Interactions --------------------------------------------------------------------------------------------------

  private dropToGround(source: DragSource, split: boolean): void {
    switch (source.kind) {
      case "ground":
        return;
      case "stack": {
        const quantity = countItem(this.equipment.inventory, source.itemId);
        if (split && quantity > 1) this.openSplit(source.itemId, quantity);
        else if (quantity > 0) this.equipment.drop({ kind: "stack", itemId: source.itemId, quantity });
        return;
      }
      case "weapon":
        this.equipment.drop({ kind: "weapon", slot: source.slot });
        return;
      case "armor":
        this.equipment.drop({ kind: "armor", slot: source.slot });
        return;
      case "backpack":
        this.equipment.drop({ kind: "backpack" });
        return;
    }
  }

  private dropOnWeaponSlot(source: DragSource, slot: WeaponSlot): void {
    if (source.kind === "ground") {
      this.equipment.pickUp(source.item.lootId, slot);
    } else if (source.kind === "weapon" && source.slot !== slot && source.slot !== 2 && slot !== 2) {
      this.equipment.swapPrimaries();
    }
  }

  /** Right-click on a bag stack: use meds, arm throwables, split-drop ammo. */
  private stackContext(itemId: StackItemId): void {
    const def = ITEMS[itemId];
    if (def.category === "heal" || def.category === "boost") this.equipment.useItem(def.id);
    else if (def.category === "throwable") this.equipment.selectThrowable(def.id);
    else this.openSplit(itemId, countItem(this.equipment.inventory, itemId));
  }

  private openSplit(itemId: StackItemId, quantity: number): void {
    if (quantity <= 0) return;
    this.hideTip();
    this.splitting = itemId;
    setText(this.splitTitle, t("inv.dropItem", { name: itemName(itemId) }));
    for (const input of [this.splitRange, this.splitNumber]) {
      input.min = "1";
      input.max = String(quantity);
      input.value = String(quantity);
    }
    this.splitter.hidden = false;
    this.splitNumber.focus();
    this.splitNumber.select();
  }

  private confirmSplit(): void {
    const itemId = this.splitting;
    if (itemId) {
      const carried = countItem(this.equipment.inventory, itemId);
      const quantity = Math.min(carried, Math.max(1, Math.floor(Number(this.splitNumber.value) || 0)));
      if (quantity > 0) this.equipment.drop({ kind: "stack", itemId, quantity });
    }
    this.closeSplit();
  }

  private closeSplit(): void {
    this.splitting = null;
    this.splitter.hidden = true;
  }

  private showNotice(message: string): void {
    setText(this.noticeText, message);
    this.notice.hidden = false;
    clearTimeout(this.noticeTimer);
    this.noticeTimer = setTimeout(() => (this.notice.hidden = true), NOTICE_MS);
  }

  private readonly handleItemEvent = (event: ItemEvent): void => {
    if (!this.open) return;
    if (event.type === "pickupFailed" || event.type === "dropFailed") this.showNotice(inventoryErrorText(event.error));
  };

  private readonly handleKey = (event: KeyboardEvent): void => {
    if (event.repeat) return;
    const isToggle = (KEY_BINDINGS.inventory as readonly string[]).includes(event.code);
    if (this.open && event.code === "Escape") {
      if (this.splitting) this.closeSplit();
      else this.setOpen(false);
      event.preventDefault();
      return;
    }
    if (!isToggle) return;
    if (this.open) {
      event.preventDefault();
      this.setOpen(false);
    } else if (this.input.isLocked) {
      event.preventDefault();
      this.setOpen(true);
    }
  };

  // ---- Tooltip -------------------------------------------------------------------------------------------------------

  /** Shows `content()` next to `node` while hovered (read on hover, so it reflects the current item). */
  private tooltip(node: HTMLElement, content: () => ItemTooltip | null): void {
    node.addEventListener("pointerenter", () => {
      if (this.dragging) return;
      const tip = content();
      if (tip) this.showTip(node, tip);
      else this.hideTip();
    });
    node.addEventListener("pointerleave", () => this.hideTip());
  }

  private showTip(anchor: HTMLElement, content: ItemTooltip): void {
    setText(this.tipTitle, content.title);
    this.tipLines.forEach((line, index) => {
      const text = content.lines[index];
      line.node.hidden = text === undefined;
      setText(line.text, text ?? "");
    });
    this.tip.hidden = false;
    // Beside the hovered element, flipped to its left near the right edge, kept inside the screen vertically.
    const rootRect = this.root.getBoundingClientRect();
    const rect = anchor.getBoundingClientRect();
    const width = this.tip.offsetWidth;
    const height = this.tip.offsetHeight;
    const gap = 8;
    let left = rect.right - rootRect.left + gap;
    let top = rect.top - rootRect.top;
    if (left + width > rootRect.width - gap) {
      left = rect.left - rootRect.left - width - gap;
      if (left < gap) {
        // No room on either side (narrow screens): below the element.
        left = Math.max(gap, Math.min(rect.left - rootRect.left, rootRect.width - width - gap));
        top = rect.bottom - rootRect.top + gap;
      }
    }
    top = Math.max(gap, Math.min(top, rootRect.height - height - gap));
    this.tip.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
  }

  private hideTip(): void {
    this.tip.hidden = true;
  }

  // ---- DOM helpers ---------------------------------------------------------------------------------------------------

  private column(parent: HTMLElement, className: string, title: MessageKey): HTMLDivElement {
    const column = el("div", className, undefined, parent);
    const head = el("div", "tb-inv__title", undefined, column);
    elT("span", "", title, head);
    return column;
  }

  private row(parent: HTMLElement): RowView {
    const node = el("div", "tb-inv__row", undefined, parent);
    const icon = this.iconSlot(el("div", "tb-inv__icon", undefined, node));
    const text = el("div", "tb-inv__row-text", undefined, node);
    const name = textNode(el("span", "tb-inv__row-name", undefined, text));
    const sub = textNode(el("span", "tb-inv__row-sub", undefined, text));
    const qty = textNode(el("span", "tb-inv__row-qty", undefined, node));
    return { node, icon, name, sub, qty, shown: "" };
  }

  private iconSlot(parent: HTMLElement): IconSlot {
    const img = el("img", "tb-inv__img", undefined, parent);
    img.alt = "";
    img.draggable = false;
    img.decoding = "async";
    img.hidden = true;
    const slot: IconSlot = { img, itemId: null, src: "" };
    this.iconSlots.push(slot);
    return slot;
  }

  private draggable(node: HTMLElement, source: () => DragSource | null, image?: HTMLImageElement): void {
    node.draggable = true;
    node.addEventListener("dragstart", (event) => {
      const drag = source();
      if (!drag || !event.dataTransfer) {
        event.preventDefault();
        return;
      }
      this.dragging = drag;
      this.hideTip();
      // Firefox only starts a drag with data set.
      event.dataTransfer.setData("text/plain", drag.kind);
      event.dataTransfer.effectAllowed = "move";
      // The item's picture follows the pointer instead of a ghost of the whole row.
      if (image && image.complete && image.naturalWidth > 0) {
        // An <img> drag image is drawn at its intrinsic size, so the offset is in image pixels.
        event.dataTransfer.setDragImage(image, image.naturalWidth / 2, image.naturalHeight / 2);
      }
      this.root.dataset.dragging = drag.kind;
    });
    node.addEventListener("dragend", () => {
      this.dragging = null;
      delete this.root.dataset.dragging;
    });
  }

  private dropZone(node: HTMLElement, onDrop: (source: DragSource, event: DragEvent) => void): void {
    node.addEventListener("dragover", (event) => {
      if (!this.dragging) return;
      event.preventDefault();
      node.toggleAttribute("data-over", true);
    });
    node.addEventListener("dragleave", (event) => {
      if (!node.contains(event.relatedTarget as Node | null)) node.removeAttribute("data-over");
    });
    node.addEventListener("drop", (event) => {
      node.removeAttribute("data-over");
      const source = this.dragging;
      if (!source) return;
      event.preventDefault();
      // Innermost zone wins (a weapon card inside the equipment column).
      event.stopPropagation();
      this.dragging = null;
      onDrop(source, event);
    });
  }
}

function backpackItemId(level: number): BackpackItemId {
  return `backpack_${level as ArmorLevel}`;
}

/** Sub line for a ground item: weapons show their loaded rounds, armor its level summary. */
function groundSummary(item: LootItem): string {
  const def = ITEMS[item.itemId];
  if (def.category === "weapon") return item.magazine ? t("inv.loaded", { summary: itemSummary(item.itemId), count: item.magazine }) : itemSummary(item.itemId);
  return itemSummary(item.itemId);
}

function groundQuantity(item: LootItem): string {
  const def = ITEMS[item.itemId];
  if (def.category === "helmet" || def.category === "vest") return `${Math.round(((item.durability ?? def.durability) / def.durability) * 100)}%`;
  if (def.category === "ammo") return `${item.quantity}`;
  return item.quantity > 1 ? `×${item.quantity}` : "";
}

function formatWeight(weight: number): string {
  return Number.isInteger(weight) ? String(weight) : weight.toFixed(1);
}

function readAutoPickup(fallback: boolean): boolean {
  try {
    const stored = localStorage.getItem(AUTO_PICKUP_STORAGE_KEY);
    return stored === null ? fallback : stored === "1";
  } catch {
    return fallback;
  }
}

function writeAutoPickup(enabled: boolean): void {
  try {
    localStorage.setItem(AUTO_PICKUP_STORAGE_KEY, enabled ? "1" : "0");
  } catch {
    // Storage blocked (private mode): the toggle still applies for this session.
  }
}
