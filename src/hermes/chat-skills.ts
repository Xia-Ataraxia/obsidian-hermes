import { AbstractInputSuggest, setTooltip, type App } from "obsidian";
import { matchSkills, type Invocation, type Pick } from "./skills-chat";
import { icon } from "./ui";

/** `/` in the composer lists the enabled skills, as the CLI's slash menu does; picking one writes `/name ` and keeps typing. */
export class SkillSuggest extends AbstractInputSuggest<Pick> {
  private opened = false;
  private closedAt = 0;

  /** The composer is a textarea, which the typings do not list; the suggest only reads `value`, events and geometry from it. */
  constructor(app: App, private readonly area: HTMLTextAreaElement, private readonly skills: () => Promise<readonly Pick[]>, private readonly picked: (text: string) => void) {
    super(app, area as unknown as HTMLInputElement);
  }

  /** Open now, or closed within this same key press: Enter that chose a skill must not also send. */
  get active(): boolean { return this.opened || performance.now() - this.closedAt < 50; }

  /** For anything but an `<input>` the base reads `innerText`, which a textarea does not have. */
  override getValue(): string { return this.area.value; }

  override open(): void { this.opened = true; super.open(); }
  override close(): void { this.opened = false; this.closedAt = performance.now(); super.close(); }

  protected async getSuggestions(value: string): Promise<Pick[]> {
    if (!value.startsWith("/") || /\s/.test(value)) return [];
    return matchSkills(await this.skills(), value.slice(1));
  }

  override renderSuggestion(skill: Pick, el: HTMLElement): void {
    el.addClass("hm-skill-item");
    el.createDiv({ cls: "suggestion-content" }).createDiv({ cls: "suggestion-title", text: `/${skill.name}` });
    if (skill.description) el.createDiv({ cls: "suggestion-note", text: skill.description });
  }

  override selectSuggestion(skill: Pick): void {
    this.area.value = `/${skill.name} `;
    this.picked(this.area.value);
    this.area.focus();
    this.close();
  }
}

/** A skill turn in the transcript: the skill as a name tag, then what the user asked of it. */
const STATE_ICONS = { running: "loader-circle", done: "check", failed: "triangle-alert" } as const;
const STATE_LABELS = { running: "Running", done: "Done", failed: "Failed" } as const;

/** `state` is the turn's, when the block is the live one; the history shows no status. */
export function skillBlock(parent: HTMLElement, { name, instruction }: Invocation, state?: keyof typeof STATE_ICONS): HTMLElement {
  const el = parent.createDiv({ cls: "hm-chat-user is-skill" });
  const tag = el.createDiv("hm-skill-tag");
  icon(tag, "sparkles", "hm-icon hm-skill-glyph");
  tag.createSpan({ cls: "hm-skill-name", text: `/${name}` });
  if (state) {
    const mark = icon(tag, STATE_ICONS[state], `hm-icon hm-skill-state is-${state}`);
    setTooltip(mark, STATE_LABELS[state]);
  }
  if (instruction) el.createDiv({ cls: "hm-skill-text", text: instruction });
  return el;
}
