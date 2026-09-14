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
  type ArmorSlot,
  type InventoryError,
  type InventoryState,
  type LootItem,
  type StackItemId,
  type ThrowableKind,
  type WeaponSlot,
} from "@twobullets/shared";
import type { EquipmentItemActions, EquipmentItemsView, ItemEvent } from "../../equipment/types";
import { KEY_BINDINGS } from "../../input/bindings";
import { setText } from "../anim";
import { el, textNode } from "../dom";
import "./inventory.css";

/** The parts of InputManager the screen needs: pointer lock state and re-locking on close. */
export interface InventoryInput {
  readonly isLocked: boolean;
  requestLock(): void;
  onLockChange(listener: (locked: boolean) => void): void;
}

type Equipment = EquipmentItemsView & EquipmentItemActions;

/** What is being dragged. */
type DragSource =
  | { readonly kind: "ground"; readonly item: LootItem }
  | { readonly kind: "stack"; readonly itemId: StackItemId }
  | { readonly kind: "weapon"; readonly slot: WeaponSlot }
  | { readonly kind: "armor"; readonly slot: ArmorSlot }
  | { readonly kind: "backpack" };

const ERROR_TEXT: Readonly<Record<InventoryError, string>> = {
  full: "Not enough space",
  overCapacity: "Not enough space for your items",
  notCarried: "Item not carried",
  invalidSlot: "Can't equip that here",
  invalidQuantity: "Invalid quantity",
};

const STACK_IDS = ITEM_IDS.filter(isStackItem);
const WEAPON_SLOT_LABELS = ["PRIMARY 1", "PRIMARY 2", "SIDEARM"] as const;
const THROWABLE_LABELS: Readonly<Record<ThrowableKind, string>> = { frag: "Frag", smoke: "Smoke", flash: "Flash", molotov: "Molotov" };
const NOTICE_MS = 1800;
const AUTO_PICKUP_STORAGE_KEY = "twobullets.autoPickup";

interface RowView {
  readonly node: HTMLDivElement;
  readonly name: Text;
  readonly detail: Text;
  shown: string;
}

interface WeaponCard {
  readonly node: HTMLDivElement;
  readonly name: Text;
  readonly ammo: Text;
  shown: string;
}

interface GearCell {
  readonly node: HTMLDivElement;
  readonly name: Text;
  readonly bar: HTMLDivElement;
  shown: string;
}

/**
 * PUBG-style inventory (Tab): vicinity list | bag with weight bar | equipment (weapons, helmet, vest, backpack,
 * throwables). Drag between columns to pick up, equip, swap or drop; right-click to use, select, equip or drop; Ctrl+drag
 * (or right-click) a stack to drop part of it. Opening releases the pointer (the game keeps running, look input stops);
 * closing asks for the lock again, otherwise the play overlay's click does it.
 *
 * DOM is built once. Each frame while open it compares the inventory object and a signature of the vicinity list and
 * rewrites only rows whose text changed.
 */
export class InventoryScreen {
  private readonly root: HTMLDivElement;
  private readonly nearbyList: HTMLDivElement;
  private readonly nearbyEmpty: HTMLDivElement;
  private readonly nearbyRows: (RowView & { item: LootItem | null })[] = [];
  private readonly bagRows = new Map<StackItemId, RowView>();
  private readonly bagEmpty: HTMLDivElement;
  private readonly capacityText: Text;
  private readonly capacityFill: HTMLDivElement;
  private readonly weaponCards: WeaponCard[] = [];
  private readonly gear: Record<"helmet" | "vest" | "backpack", GearCell>;
  private readonly throwables = new Map<ThrowableKind, { node: HTMLDivElement; count: Text; shown: string }>();
  private readonly notice: HTMLDivElement;
  private readonly noticeText: Text;
  private readonly splitter: HTMLDivElement;
  private readonly splitRange: HTMLInputElement;
  private readonly splitNumber: HTMLInputElement;
  private readonly splitTitle: Text;
  private readonly autoPickup: HTMLInputElement;
  private readonly itemObserver: Observer<ItemEvent>;
  private readonly events = new AbortController();

  private open = false;
  private dragging: DragSource | null = null;
  private splitting: StackItemId | null = null;
  private shownInventory: InventoryState | null = null;
  private shownNearby = "";
  private noticeTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    parent: HTMLElement,
    private readonly equipment: Equipment,
    private readonly input: InventoryInput,
  ) {
    // Inside the HUD layer so the --tb-* tokens apply; the stylesheet hides the play overlay while this is open.
    const host = parent.querySelector<HTMLElement>(".tb-hud") ?? parent;
    this.root = el("div", "tb-inv", undefined, host);
    this.root.hidden = true;
    const panel = el("div", "tb-inv__panel", undefined, this.root);

    // Vicinity
    const nearby = this.column(panel, "tb-inv__col tb-inv__col--nearby", "VICINITY");
    this.nearbyList = el("div", "tb-inv__list", undefined, nearby);
    this.nearbyEmpty = el("div", "tb-inv__empty", "Nothing within reach", this.nearbyList);
    this.dropZone(nearby, (source, event) => this.dropToGround(source, event.ctrlKey || event.shiftKey));

    // Bag
    const bag = this.column(panel, "tb-inv__col tb-inv__col--bag", "BAG");
    const capacity = el("div", "tb-inv__capacity", undefined, bag);
    const bar = el("div", "tb-inv__bar", undefined, capacity);
    this.capacityFill = el("div", "tb-inv__bar-fill", undefined, bar);
    this.capacityText = textNode(el("span", "tb-inv__capacity-text", undefined, capacity));
    const bagList = el("div", "tb-inv__list", undefined, bag);
    this.bagEmpty = el("div", "tb-inv__empty", "Empty", bagList);
    for (const itemId of STACK_IDS) {
      const row = this.row(bagList);
      row.node.hidden = true;
      this.draggable(row.node, () => ({ kind: "stack", itemId }));
      row.node.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        this.stackContext(itemId);
      });
      this.bagRows.set(itemId, row);
    }
    this.dropZone(bag, (source) => {
      if (source.kind === "ground") this.equipment.pickUp(source.item.lootId);
    });

    // Equipment
    const gearCol = this.column(panel, "tb-inv__col tb-inv__col--gear", "EQUIPMENT");
    const weapons = el("div", "tb-inv__weapons", undefined, gearCol);
    WEAPON_SLOT_LABELS.forEach((label, index) => {
      const slot = index as WeaponSlot;
      const node = el("div", "tb-inv__weapon", undefined, weapons);
      const head = el("div", "tb-inv__weapon-head", undefined, node);
      el("span", "tb-key", String(index + 1), head);
      el("span", "tb-inv__label", label, head);
      const name = textNode(el("div", "tb-inv__weapon-name", undefined, node));
      const ammo = textNode(el("div", "tb-inv__weapon-ammo", undefined, node));
      this.draggable(node, () => (this.equipment.inventory.weapons[slot] ? { kind: "weapon", slot } : null));
      node.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        if (this.equipment.inventory.weapons[slot]) this.equipment.drop({ kind: "weapon", slot });
      });
      this.dropZone(node, (source) => this.dropOnWeaponSlot(source, slot));
      this.weaponCards.push({ node, name, ammo, shown: "" });
    });

    const gearRow = el("div", "tb-inv__gear", undefined, gearCol);
    const gearCell = (key: "helmet" | "vest" | "backpack", label: string): GearCell => {
      const node = el("div", "tb-inv__cell", undefined, gearRow);
      el("div", "tb-inv__label", label, node);
      const name = textNode(el("div", "tb-inv__cell-name", undefined, node));
      const barNode = el("div", "tb-inv__bar tb-inv__bar--thin", undefined, node);
      const fill = el("div", "tb-inv__bar-fill", undefined, barNode);
      const source = (): DragSource | null => {
        const inventory = this.equipment.inventory;
        if (key === "backpack") return inventory.backpack > 0 ? { kind: "backpack" } : null;
        return inventory[key] ? { kind: "armor", slot: key } : null;
      };
      this.draggable(node, source);
      node.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        const drag = source();
        if (drag) this.dropToGround(drag, false);
      });
      return { node, name, bar: fill, shown: "" };
    };
    this.gear = { helmet: gearCell("helmet", "HELMET"), vest: gearCell("vest", "VEST"), backpack: gearCell("backpack", "BACKPACK") };

    const throwRow = el("div", "tb-inv__throwables", undefined, gearCol);
    el("span", "tb-key", "5", throwRow);
    for (const kind of THROWABLE_KINDS) {
      const node = el("div", "tb-inv__chip", undefined, throwRow);
      el("span", "", THROWABLE_LABELS[kind], node);
      const count = textNode(el("span", "tb-inv__chip-count", undefined, node));
      node.addEventListener("click", () => this.equipment.selectThrowable(kind));
      node.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        this.equipment.selectThrowable(kind);
      });
      this.throwables.set(kind, { node, count, shown: "" });
    }
    this.dropZone(gearCol, (source) => {
      if (source.kind === "ground") this.equipment.pickUp(source.item.lootId);
    });

    // Footer: hints, auto pickup, notices.
    const footer = el("div", "tb-inv__footer", undefined, this.root);
    el("span", "tb-inv__hint", "Drag to move · Right-click to use / equip / drop · Ctrl+drag to drop part of a stack · Tab to close", footer);
    const toggle = el("label", "tb-inv__toggle", undefined, footer);
    this.autoPickup = el("input", "", undefined, toggle);
    this.autoPickup.type = "checkbox";
    el("span", "", "Auto pickup", toggle);
    this.equipment.autoPickup = readAutoPickup(this.equipment.autoPickup);
    this.autoPickup.checked = this.equipment.autoPickup;
    this.autoPickup.addEventListener("change", () => {
      this.equipment.autoPickup = this.autoPickup.checked;
      writeAutoPickup(this.autoPickup.checked);
    });
    this.notice = el("div", "tb-inv__notice", undefined, this.root);
    this.noticeText = textNode(this.notice);
    this.notice.hidden = true;

    // Stack split popover.
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
    el("button", "tb-inv__button", "Drop", buttons).addEventListener("click", () => this.confirmSplit());
    el("button", "tb-inv__button tb-inv__button--quiet", "Cancel", buttons).addEventListener("click", () => this.closeSplit());
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

  /** Per render frame; cheap when closed or unchanged. */
  update(): void {
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
  }

  dispose(): void {
    this.events.abort();
    this.itemObserver.remove();
    clearTimeout(this.noticeTimer);
    this.root.remove();
  }

  // ---- Rendering -----------------------------------------------------------------------------------------------------

  private renderInventory(inventory: InventoryState): void {
    const { used, max } = this.equipment.capacity;
    setText(this.capacityText, `${formatWeight(used)} / ${max}`);
    this.capacityFill.style.transform = `scaleX(${Math.min(1, max > 0 ? used / max : 0)})`;
    this.capacityFill.toggleAttribute("data-full", used >= max);

    let any = false;
    for (const [itemId, row] of this.bagRows) {
      const quantity = countItem(inventory, itemId);
      row.node.hidden = quantity === 0;
      if (quantity === 0) continue;
      any = true;
      updateRow(row, ITEMS[itemId].name, `${quantity}`, `${quantity}`);
    }
    this.bagEmpty.hidden = any;

    inventory.weapons.forEach((weapon, index) => {
      const card = this.weaponCards[index]!;
      const key = weapon ? `${weapon.weaponId}:${weapon.magazine}:${countItem(inventory, ammoForWeapon(weapon.weaponId))}` : "";
      if (key === card.shown) return;
      card.shown = key;
      card.node.toggleAttribute("data-empty", !weapon);
      if (!weapon) {
        setText(card.name, "Empty");
        setText(card.ammo, "");
        return;
      }
      const ammo = ammoForWeapon(weapon.weaponId);
      setText(card.name, WEAPONS[weapon.weaponId].name);
      setText(card.ammo, `${weapon.magazine} / ${countItem(inventory, ammo)}  ${ITEMS[ammo].name}`);
    });

    for (const slot of ["helmet", "vest"] as const) {
      const piece = inventory[slot];
      const cell = this.gear[slot];
      const condition = armorCondition(slot, piece);
      updateGear(cell, piece ? `Lv.${piece.level}` : "—", piece ? condition : null);
    }
    updateGear(this.gear.backpack, inventory.backpack > 0 ? `Lv.${inventory.backpack}` : "—", null);

    for (const [kind, chip] of this.throwables) {
      const count = countItem(inventory, kind);
      const key = `${count}:${inventory.selectedThrowable === kind}`;
      if (key === chip.shown) continue;
      chip.shown = key;
      setText(chip.count, count > 0 ? `${count}` : "");
      chip.node.toggleAttribute("data-empty", count === 0);
      chip.node.toggleAttribute("data-selected", inventory.selectedThrowable === kind);
    }
  }

  private renderNearby(items: readonly LootItem[]): void {
    while (this.nearbyRows.length < items.length) {
      const row = { ...this.row(this.nearbyList), item: null as LootItem | null };
      this.draggable(row.node, () => (row.item ? { kind: "ground", item: row.item } : null));
      row.node.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        if (row.item) this.equipment.pickUp(row.item.lootId);
      });
      this.nearbyRows.push(row);
    }
    this.nearbyRows.forEach((row, index) => {
      const item = items[index] ?? null;
      row.item = item;
      row.node.hidden = item === null;
      if (item) updateRow(row, itemName(item), groundDetail(item), `${item.lootId}:${item.quantity}:${item.durability ?? ""}`);
    });
    this.nearbyEmpty.hidden = items.length > 0;
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
    this.splitting = itemId;
    setText(this.splitTitle, `Drop ${ITEMS[itemId].name}`);
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
    if (event.type === "pickupFailed" || event.type === "dropFailed") this.showNotice(ERROR_TEXT[event.error]);
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

  // ---- DOM helpers ---------------------------------------------------------------------------------------------------

  private column(parent: HTMLElement, className: string, title: string): HTMLDivElement {
    const column = el("div", className, undefined, parent);
    el("div", "tb-inv__title", title, column);
    return column;
  }

  private row(parent: HTMLElement): RowView {
    const node = el("div", "tb-inv__row", undefined, parent);
    const name = textNode(el("span", "tb-inv__row-name", undefined, node));
    const detail = textNode(el("span", "tb-inv__row-detail", undefined, node));
    return { node, name, detail, shown: "" };
  }

  private draggable(node: HTMLElement, source: () => DragSource | null): void {
    node.draggable = true;
    node.addEventListener("dragstart", (event) => {
      const drag = source();
      if (!drag || !event.dataTransfer) {
        event.preventDefault();
        return;
      }
      this.dragging = drag;
      // Firefox only starts a drag with data set.
      event.dataTransfer.setData("text/plain", drag.kind);
      event.dataTransfer.effectAllowed = "move";
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

function updateRow(row: RowView, name: string, detail: string, key: string): void {
  if (key === row.shown) return;
  row.shown = key;
  setText(row.name, name);
  setText(row.detail, detail);
}

function updateGear(cell: GearCell, name: string, condition: number | null): void {
  const key = `${name}:${condition === null ? "" : condition.toFixed(2)}`;
  if (key === cell.shown) return;
  cell.shown = key;
  setText(cell.name, name);
  cell.node.toggleAttribute("data-empty", name === "—");
  cell.bar.parentElement!.hidden = condition === null;
  if (condition !== null) {
    cell.bar.style.transform = `scaleX(${condition})`;
    cell.bar.toggleAttribute("data-low", condition < 0.3);
  }
}

function itemName(item: LootItem): string {
  return ITEMS[item.itemId].name;
}

function groundDetail(item: LootItem): string {
  const def = ITEMS[item.itemId];
  if (def.category === "helmet" || def.category === "vest") return `${Math.round(((item.durability ?? def.durability) / def.durability) * 100)}%`;
  if (def.category === "weapon") return item.magazine ? `${item.magazine} rds` : "";
  return item.quantity > 1 || def.category === "ammo" ? `${item.quantity}` : "";
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
