import type { BoardKey } from "../types/control-center";
import { CANVAS_TYPES } from "../types/profiles-canvas";
import type { CanvasFilters } from "../types/profiles-canvas";
import { canvasButton, canvasElement } from "./profiles-canvas-dom";

export class ProfilesCanvasControls {
  readonly search: HTMLInputElement;
  private readonly board: HTMLSelectElement;
  private boards: readonly BoardKey[] = [];
  private boardSignature = "";
  constructor(parent: HTMLElement, private readonly filters: () => CanvasFilters, search: (query: string) => void, changed: (filters: CanvasFilters) => void, refresh: () => void) {
    const bar = canvasElement(parent, "div", "hpc-controls");
    this.search = canvasElement(bar, "input", "hpc-search");
    this.search.type = "search";
    this.search.placeholder = "프로파일 검색";
    this.search.setAttribute("aria-label", "프로파일 검색");
    this.search.addEventListener("input", () => search(this.search.value));
    this.board = canvasElement(bar, "select", "");
    this.board.setAttribute("aria-label", "활동 보드");
    this.board.addEventListener("change", () => {
      const selected = this.boards.find(board => board.board === this.board.value);
      changed({ ...filters(), boards: selected ? [selected.board] : [] });
    });
    const window = canvasElement(bar, "select", "");
    window.setAttribute("aria-label", "활동 기간");
    for (const preset of [7, 30, 90, "all"] as const) {
      const option = canvasElement(window, "option", "", preset === "all" ? "전체 기간" : `최근 ${preset}일`);
      option.value = String(preset);
    }
    window.value = String(filters().window);
    window.addEventListener("change", () => {
      const preset = [7, 30, 90, "all"].find(value => String(value) === window.value);
      if (preset === 7 || preset === 30 || preset === 90 || preset === "all") changed({ ...filters(), window: preset });
    });
    const types = canvasElement(bar, "details", "hpc-type-filter");
    canvasElement(types, "summary", "", "이벤트 유형");
    const choices = canvasElement(types, "div", "hpc-type-choices");
    for (const type of CANVAS_TYPES) {
      const label = canvasElement(choices, "label", "");
      const check = canvasElement(label, "input", "");
      check.type = "checkbox";
      check.checked = filters().types.includes(type);
      canvasElement(label, "span", "", type);
      check.addEventListener("change", () => changed({ ...filters(), types: check.checked ? [...filters().types, type] : filters().types.filter(value => value !== type) }));
    }
    canvasButton(bar, "새로 고침", refresh);
  }
  updateBoards(boards: readonly BoardKey[]): void {
    const signature = JSON.stringify([boards, this.filters().boards]);
    if (signature === this.boardSignature) return;
    this.boardSignature = signature;
    this.boards = boards;
    this.board.replaceChildren();
    const all = canvasElement(this.board, "option", "", "모든 보드");
    all.value = "";
    for (const board of boards) {
      const option = canvasElement(this.board, "option", "", board.board);
      option.value = board.board;
    }
    for (const missing of this.filters().boards.filter(id => !boards.some(board => board.board === id))) {
      const option = canvasElement(this.board, "option", "", `${missing} · 확인 불가`);
      option.value = missing;
    }
    this.board.value = this.filters().boards[0] ?? "";
  }
}
