import { SuggestModal, type App } from "obsidian";
import { icon } from "./ui";

export type Pair = [model: string, provider: string];

/** Substring filter over [model, provider]; a typed id that matches no model is offered as custom on the current provider. */
export class ModelPicker extends SuggestModal<Pair> {
  constructor(app: App, readonly pairs: Pair[], private readonly current: Pair, private readonly pick: (pair: Pair) => Promise<void>) {
    super(app);
    this.setPlaceholder("Default model");
  }

  getSuggestions(query: string): Pair[] {
    const q = query.trim();
    const hits = this.pairs.filter(pair => pair.join(" ").toLowerCase().includes(q.toLowerCase()));
    return q && !hits.some(([model]) => model === q) ? [...hits, [q, this.current[1]]] : hits;
  }

  renderSuggestion(pair: Pair, el: HTMLElement): void {
    const [model, provider] = pair;
    el.addClass("mod-complex");
    const content = el.createDiv("suggestion-content");
    content.createDiv({ cls: "suggestion-title", text: model });
    content.createDiv({ cls: "suggestion-note", text: this.pairs.includes(pair) ? provider : ["custom", provider].filter(Boolean).join(" · ") });
    if (model === this.current[0] && provider === this.current[1]) icon(el.createDiv("suggestion-aux"), "check");
  }

  onChooseSuggestion(pair: Pair): void { void this.pick(pair); }
}

