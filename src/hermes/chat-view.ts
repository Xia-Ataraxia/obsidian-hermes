import { Component, Menu, Notice, setTooltip, type ViewStateResult, type WorkspaceLeaf } from "obsidian";
import { keepChat } from "./cache";
import { ChatHud } from "./chat-hud";
import { chips, foot, outcome } from "./chat-parts";
import { QueueBar } from "./chat-queue";
import { SkillSuggest, skillBlock } from "./chat-skills";
import { reduce, SESSION_ID, sessionFrom, type ChatState, type Turn, type Usage } from "./chat";
import { renderSafe } from "./markdown";
import { safeToken } from "./remote";
import { SendQueue, type Queued } from "./send-queue";
import { askFor, slashSkill, userInvocation, type Pick } from "./skills-chat";
import { avatar, HermesView, iconButton, relative, stat, type HermesHost } from "./ui";

export const CHAT_VIEW = "hermes-chat";

const SOURCE_ICONS: Record<string, string> = { cli: "message-square", tui: "terminal", desktop: "monitor", local: "laptop", acp: "plug" };
// There is no cancel in the gateway: stopping only drops our ssh, the turn itself runs on.
const STOP = "Stop waiting (the reply may still arrive)";
const NO_HOST = "Add an SSH host to chat";

/** Side-panel chat with one profile at a time; every `alias/profile` keeps its own thread, draft and running turn. */
export class ChatView extends HermesView {
  private profile = "default";
  private profiles: { id: string; live: boolean }[] = [];
  private readonly states = new Map<string, ChatState>();
  /** The running turn per `alias/profile`; calling it stops waiting. */
  private readonly streams = new Map<string, () => void>();
  /** The sid whose rows each `alias/profile` holds; a mismatch means they are still loading. */
  private readonly loaded = new Map<string, string>();
  private head!: HTMLElement;
  private input!: HTMLTextAreaElement;
  private button!: HTMLButtonElement;
  /** The log's two parts: the history, and the current turn that tool events and the Session line rebuild alone. */
  private historyEl: HTMLElement | null = null;
  private turnEl: HTMLElement | null = null;
  /** Own each part's rendered markdown; replaced when the part rebuilds so children don't pile up on the view. */
  private md = new Component();
  private turnMd = new Component();
  /** What each part was last built from; an equal signature skips its rebuild. */
  private sig = "";
  private turnSig = "";
  private chipSig = "";
  private headSig = "";
  /** The streaming reply's text node; deltas patch it in place. */
  private live: Text | null = null;
  /** A read is in flight (it never throws, so the flag always clears). */
  private pulling = false;
  private hud!: ChatHud;
  private suggest!: SkillSuggest;
  private hudKey = "";
  /** Messages waiting for the running turn, per `alias/profile`, so they outlive pane and profile switches. */
  private readonly queues = new Map<string, SendQueue>();
  /** Why a queue is paused ("" after a stop); a failure shows it next to Retry. */
  private readonly pauseWhy = new Map<string, string>();
  private queueBar!: QueueBar;
  private queueKey = "";
  private stopButton!: HTMLButtonElement;

  constructor(leaf: WorkspaceLeaf, host: HermesHost) {
    super(leaf, host, 30_000);
  }

  getViewType(): string { return CHAT_VIEW; }
  getDisplayText(): string { return "Hermes chat"; }
  override getIcon(): string { return "message-square"; }

  /** A streaming turn repaints itself; a poll's rebuild would only fight it. */
  protected override busy(): boolean { return this.streams.has(this.key()); }

  private key(profile = this.profile): string { return `${this.alias}/${profile}`; }

  private state(key: string): ChatState {
    let state = this.states.get(key);
    if (!state) this.states.set(key, state = { sid: "", threads: [], rows: [], draft: "", turn: null, extras: {} });
    return state;
  }

  override getState(): Record<string, unknown> {
    const sessions = Object.fromEntries([...this.states].filter(([, s]) => s.sid).map(([key, s]) => [key, s.sid]));
    return { ...super.getState(), profile: this.profile, sessions };
  }

  override async setState(state: unknown, result: ViewStateResult): Promise<void> {
    const { alias, profile, sessions } = (state ?? {}) as { alias?: unknown; profile?: unknown; sessions?: unknown };
    const shown = () => `${this.key()} ${this.states.get(this.key())?.sid ?? ""}`, was = shown();
    if (sessions && typeof sessions === "object") {
      for (const [key, sid] of Object.entries(sessions)) if (typeof sid === "string" && SESSION_ID.test(sid)) this.state(key).sid ||= sid;
    }
    // All of it before the base, which then sees no alias change; one reload reads the right profile and thread.
    // ponytail: opening still reads twice, since onOpen's read predates this one and the reload queues behind it.
    if (typeof alias === "string" && this.host.servers().includes(alias)) this.alias = alias;
    if (typeof profile === "string") { try { this.profile = safeToken(profile); } catch { /* keep the current one */ } }
    await super.setState(state, result);
    // Re-revealing the leaf passes no state: nothing to read again.
    if (!this.input || shown() === was) return;
    this.render();
    void this.reload();
  }

  override async onOpen(): Promise<void> {
    const opened = super.onOpen();
    this.head = this.contentEl.createDiv("hm-chat-head");
    this.body.before(this.head);
    this.body.addClass("hm-chat-log");
    this.body.setAttrs({ role: "log", "aria-live": "polite" });
    this.hud = new ChatHud(this.contentEl, () => this.host.chat.hud(this.alias, this.profile), () => !!this.alias && this.contentEl.isShown());
    this.registerInterval(this.contentEl.win.setInterval(() => this.hud.tick(), 1000));
    this.queueBar = new QueueBar(this.contentEl, {
      edit: id => this.editQueued(id),
      remove: id => { this.queue(this.key()).remove(id); this.syncQueue(); },
      resume: () => this.resume(),
      clear: () => this.clearQueue(),
    });
    // Built once: a repaint never touches the draft, the focus or an IME composition.
    const composer = this.contentEl.createDiv("hm-chat-composer");
    this.input = composer.createEl("textarea", { attr: { rows: "1", "aria-label": "Message" } });
    this.input.addEventListener("input", () => { this.state(this.key()).draft = this.input.value; });
    this.suggest = new SkillSuggest(this.app, this.input, () => this.skills(), text => { this.state(this.key()).draft = text; });
    this.input.addEventListener("keydown", event => {
      if (event.key !== "Enter" || event.shiftKey || event.isComposing || this.suggest.active) return;
      event.preventDefault();
      this.send();
    });
    this.stopButton = iconButton(composer, "square", STOP, () => this.streams.get(this.key())?.(), "hm-stop");
    this.stopButton.hidden = true;
    this.button = iconButton(composer, "send-horizontal", "Send", () => this.send());
    // The head and composer need no pull; drawn now, an unreachable host still shows them.
    if (this.alias) this.render();
    else this.noHost(true);
    await opened;
  }

  /** Without a host there is nothing to send to: the composer reads as inactive and the activity strip steps aside. */
  private noHost(on: boolean): void {
    this.input.disabled = on;
    this.button.disabled = on;
    if (on) this.input.placeholder = NO_HOST;
    this.hud.show(!on);
  }

  /** The chrome follows the host list too: a new host draws it, losing the last one clears it. */
  override serversChanged(): void {
    super.serversChanged();
    if (this.closed || !this.input) return;
    this.noHost(!this.alias);
    if (this.alias) { if (!this.busy()) this.render(); return; }
    this.head.empty();
    this.headSig = "";
    this.hudKey = "";
    this.hud.reset();
  }

  /** Drops our ssh processes; the turns themselves finish on the server. */
  override async onClose(): Promise<void> {
    await super.onClose();
    for (const stop of this.streams.values()) stop();
    this.streams.clear();
  }

  /** Show `profile` on `alias` and focus the composer; "Chat with this profile" lands here. */
  focusProfile(alias: string, profile: string): void {
    if (alias !== this.alias && this.host.servers().includes(alias)) {
      this.alias = alias;
      const select = this.toolbar?.querySelector<HTMLSelectElement>("select.hm-server");
      if (select) select.value = alias;
    }
    this.select(profile);
    this.input?.focus();
  }

  /** The base's empty states replace the log, so the next render must rebuild it. */
  protected override empty(iconName: string, text: string, action?: string, onAction?: () => void, detail?: string): void {
    this.sig = this.turnSig = "";
    this.live = null;
    super.empty(iconName, text, action, onAction, detail);
  }

  /** Switch to `profile`; its thread, draft and any running turn come back with it. */
  private select(profile: string): void {
    try { this.profile = safeToken(profile); } catch { /* keep the current one: profileDir throws on it and pull must not */ }
    this.app.workspace.requestSaveLayout();
    if (!this.input) return;
    this.render();
    void this.reload();
  }

  /** Show thread `sid`, or with "" start a new one on the next send. Not `open`: that name is View's own (it mounts the leaf). */
  private openThread(sid: string): void {
    const key = this.key(), s = this.state(key);
    if (this.streams.has(key)) return;
    s.sid = sid;
    s.rows = [];
    s.turn = null;
    this.loaded.delete(key);
    this.app.workspace.requestSaveLayout();
    this.render();
    this.input.focus();
    if (sid) void this.reload();
  }

  /** Only the profile chips are kept; a thread, its title and its messages are always read live. */
  protected override cacheKey(): string { return "chat"; }

  protected override cacheData(): unknown { return keepChat(this.profiles); }

  protected override cacheRestore(saved: unknown): boolean {
    const list = (saved as { profiles?: unknown } | null)?.profiles;
    this.profiles = [];
    if (Array.isArray(list)) {
      for (const p of list as ({ id?: unknown; live?: unknown } | null)[]) if (typeof p?.id === "string") this.profiles.push({ id: p.id, live: p.live === true });
    }
    return this.profiles.length > 0;
  }

  protected async pull(alias: string): Promise<string | null> {
    const profile = this.profile, key = `${alias}/${profile}`, s = this.state(key), sid = s.sid;
    this.pulling = true;
    const result = await this.host.chat.read(alias, profile, sid);
    this.pulling = false;
    if (typeof result === "string") return result;
    s.threads = result.threads;
    if (s.sid === sid) {
      s.rows = result.rows;
      this.loaded.set(key, sid);
      // A finished or abandoned turn gives way to the transcript once its reply lands; a failure stays until the next send.
      // Without a known `after` its rows cannot be told apart, so it stays.
      const turn = s.turn, after = turn?.after ?? null;
      if (turn?.done && after !== null && (turn.code === 0 || turn.code === null) && s.rows.some(row => row.id > after && row.role === "assistant" && row.text)) {
        const user = s.rows.find(row => row.id > after && row.role === "user");
        if (user && turn.usage) s.extras[user.id] = { tools: turn.tools, usage: turn.usage, skill: turn.skill };
        s.turn = null;
      }
    }
    if (alias === this.alias) {
      this.profiles = result.profiles;
      const first = result.profiles[0];
      if (first && !result.profiles.some(p => p.id === this.profile)) this.select(first.id);
    }
    return null;
  }

  /** The enabled skills of the shown profile, read once per profile and cached by the inspector. */
  private async skills(): Promise<Pick[]> {
    const detail = this.host.inspect.cached(this.alias, this.profile) ?? await this.host.inspect.detail(this.alias, this.profile);
    return typeof detail === "string" ? [] : detail.skills.filter(skill => skill.enabled);
  }

  private send(): void {
    const text = this.input.value.trim();
    if (!text.startsWith("/")) { this.dispatch(text, text); return; }
    void this.skills().then(skills => {
      const call = slashSkill(text, skills);
      if (call) this.dispatch(text, call.instruction || askFor(call.name), call.name);
      else new Notice("Unknown skill. Other slash commands only work in the terminal");
    });
  }

  private queue(key: string): SendQueue {
    let queue = this.queues.get(key);
    if (!queue) this.queues.set(key, queue = new SendQueue());
    return queue;
  }

  /** Send now, or queue behind the running turn and whatever already waits (order is kept). */
  private dispatch(draft: string, query: string, skill = ""): void {
    const key = this.key(), queue = this.queue(key);
    if (!query || !this.alias) return;
    if (!this.streams.has(key) && !queue.list.length) { this.submit(draft, query, skill); return; }
    // Twice base64-encoded it must stay under Linux's 128 KB limit for one ssh argument.
    if (Buffer.byteLength(query) > 32 * 1024) { new Notice("Message is too long (over 32,768 bytes)"); return; }
    queue.push({ alias: this.alias, profile: this.profile, draft, query, skill });
    this.state(key).draft = this.input.value = "";
    this.syncQueue();
  }

  /** Send the next queued message once nothing runs; a paused queue waits for Resume. */
  private drain(key: string): void {
    if (this.streams.has(key)) return;
    const next = this.queues.get(key)?.take();
    if (!next) return;
    this.queueBar.markSent(next.id);
    this.submit(next.draft, next.query, next.skill, next);
  }

  private resume(): void {
    const key = this.key(), queue = this.queue(key);
    queue.paused = false;
    this.pauseWhy.delete(key);
    this.drain(key);
    this.syncQueue();
  }

  private clearQueue(): void {
    this.queue(this.key()).clear();
    this.pauseWhy.delete(this.key());
    this.syncQueue();
  }

  /** Back into the composer, after whatever is already typed there. */
  private editQueued(id: number): void {
    const key = this.key(), item = this.queue(key).remove(id);
    if (!item) return;
    const s = this.state(key);
    s.draft = this.input.value = s.draft ? `${s.draft}\n${item.draft}` : item.draft;
    this.input.focus();
    this.syncQueue();
  }

  private syncQueue(): void {
    const key = this.key(), queue = this.queues.get(key);
    if (key !== this.queueKey) { this.queueKey = key; this.queueBar.reset(); }
    this.queueBar.sync(queue?.list ?? [], queue?.paused ?? false, this.pauseWhy.get(key) ?? "");
  }

  /** `draft` is what was typed (handed back when the turn never started), `query` what the CLI is asked, `skill` the one to preload. */
  private submit(draft: string, query: string, skill = "", from?: Queued): void {
    const text = query, alias = from?.alias ?? this.alias, profile = from?.profile ?? this.profile, key = `${alias}/${profile}`, s = this.state(key);
    if (!text || !alias || this.streams.has(key)) return;
    // Twice base64-encoded it must stay under Linux's 128 KB limit for one ssh argument.
    if (Buffer.byteLength(text) > 32 * 1024) { new Notice("Message is too long (over 32,768 bytes)"); return; }
    // Rows loaded for this thread bound the turn from below; otherwise wait for the server's `after` line.
    const after = this.loaded.get(key) === s.sid ? Math.max(0, ...s.rows.map(row => row.id)) : null;
    const turn: Turn = { user: text, after, sid: s.sid, code: null, text: "", tools: [], usage: null, error: null, done: false, skill: skill || undefined };
    s.turn = turn;
    if (!from) s.draft = this.input.value = "";
    let user = false, seen = false, frame = 0;
    const handle = this.host.chat.send(alias, profile, s.sid, text, line => {
      const change = reduce(turn, line);
      if (!change || key !== this.key()) return;
      if (change !== "text" || !this.live?.isConnected) { this.render(); return; }
      // At most one patch per frame, however fast the deltas come; it writes the whole text so far.
      frame ||= this.body.win.requestAnimationFrame(() => {
        frame = 0;
        const log = this.body, live = this.live;
        if (key !== this.key() || !live?.isConnected) return;
        const bottom = log.scrollHeight - log.scrollTop - log.clientHeight < 4;
        live.data = turn.text;
        if (bottom) log.scrollTop = log.scrollHeight;
      });
    }, line => {
      // Printed before the CLI submits, for a new thread and a resume alike; a resume may land on the lineage's tip.
      const sid = sessionFrom(line);
      if (!sid) return;
      seen = true;
      if (sid === turn.sid) return;
      turn.sid = s.sid = sid;
      this.app.workspace.requestSaveLayout();
      if (key === this.key()) this.render();
    }, skill);
    this.streams.set(key, () => { user = true; handle.stop(); });
    this.render();
    void handle.done.then(exit => {
      if (!this.streams.delete(key)) return; // the view closed
      const tail = exit.stderrTail.split("\n").map(line => line.trim()).filter(line => line && !sessionFrom(line)).pop() ?? "";
      const code = turn.code ?? exit.exitCode;
      turn.done = true;
      turn.code = code;
      turn.refused = exit.refused ?? false;
      if (!turn.error && code !== 0 && !(user && code === null)) turn.error = tail || null;
      if (turn.sid) s.sid = turn.sid;
      if (code === 1) {
        new Notice(`${profile}: ${turn.error ?? "Hermes chat failed"}`);
        if (turn.error?.includes("No session found")) s.sid = turn.sid = "";
      }
      this.app.workspace.requestSaveLayout();
      // No `Session:` line means the CLI never submitted it; after a refusal or a failed exit, hand the text back
      // rather than lose it. A stop leaves the "Stopped waiting" note instead.
      const unsent = !seen && (turn.refused || (code !== null && code !== 0));
      if (unsent && !from && !s.draft) {
        s.draft = draft;
        if (key === this.key()) this.input.value = draft;
      }
      // Anything but a clean reply holds the queue: a failed message goes back to its head, and Retry sends it again.
      const queue = this.queue(key);
      if (from && unsent) queue.requeue(from);
      if (code !== 0 && (from || queue.list.length)) {
        queue.paused = true;
        this.pauseWhy.set(key, user && code === null ? "" : turn.error ?? `Exit ${code}`);
      }
      this.repaint(); // also when off screen: the chip stops pulsing
      // A read already in flight may predate the reply; pull once more after it, or the turn waits for the next poll.
      // The next queued message goes out only after, so its `after` bound counts this reply.
      const settled = key !== this.key() ? Promise.resolve() : this.pulling ? this.reload(true).then(() => this.reload(true)) : this.reload(true);
      void settled.then(() => { this.drain(key); this.syncQueue(); });
    });
  }

  protected render(): void {
    const key = this.key(), s = this.state(key), streaming = this.streams.has(key);
    if (this.input.value !== s.draft) this.input.value = s.draft;
    this.input.placeholder = `Message ${this.profile}…`;
    this.stopButton.hidden = !streaming;

    // The chips and the head rebuild only when what they show changed, so a poll leaves the focus on them alone.
    const chipSig = JSON.stringify(this.profiles.map(({ id }) => [id, id === this.profile, this.streams.has(this.key(id))]));
    if (chipSig !== this.chipSig || !this.tools.firstChild) { // an empty `tools` is a new one from the base's toolbar
      this.chipSig = chipSig;
      this.tools.empty();
      const chips = this.tools.createDiv("hm-chat-chips");
      for (const { id } of this.profiles) {
        const chip = chips.createEl("button", { cls: "hm-chat-chip clickable-icon", attr: { "aria-label": id, "aria-pressed": String(id === this.profile) } });
        chip.toggleClass("is-streaming", this.streams.has(this.key(id)));
        avatar(chip, id, "hm-avatar is-small");
        setTooltip(chip, id);
        chip.addEventListener("click", () => { this.select(id); this.input.focus(); });
      }
    }

    const known = this.profiles.find(p => p.id === this.profile);
    const thread = s.threads.find(t => t.id === s.sid);
    const title = thread?.title || s.rows.find(row => row.role === "user")?.text.slice(0, 60) || s.turn?.user.slice(0, 60) || s.sid || "New thread";
    const label = [this.profile, title, thread ? relative(thread.at) : ""].filter(Boolean).join(" · ");
    const headSig = JSON.stringify([key, known?.live, label, streaming]);
    if (headSig !== this.headSig) {
      this.headSig = headSig;
      this.head.empty();
      if (known) {
        const dot = this.head.createSpan("hm-gw");
        dot.toggleClass("is-live", known.live);
        dot.toggleClass("is-down", !known.live);
        setTooltip(dot, known.live ? "Gateway running" : "Gateway not running");
      }
      setTooltip(this.head.createDiv({ cls: "hm-chat-title", text: label }), label);
      iconButton(this.head, "plus", "New thread", () => this.openThread("")).disabled = streaming;
      const recent = iconButton(this.head, "history", "Recent threads", event => {
        const menu = new Menu();
        for (const t of s.threads) {
          menu.addItem(item => item.setTitle(`${t.title || t.id} · ${relative(t.at)}`).setIcon(SOURCE_ICONS[t.source] ?? "message-square")
            .setChecked(t.id === s.sid).onClick(() => this.openThread(t.id)));
        }
        if (!s.threads.length) menu.addItem(item => item.setTitle("No threads yet").setDisabled(true));
        // A click from the keyboard (detail 0) has no pointer position; open the menu under the button.
        if (event.detail === 0) {
          const rect = recent.getBoundingClientRect();
          menu.showAtPosition({ x: rect.left, y: rect.bottom });
        } else menu.showAtMouseEvent(event);
      });
      recent.disabled = streaming;
    }

    if (key !== this.hudKey) {
      this.hudKey = key;
      this.hud.reset();
      void this.hud.poll();
    }
    this.syncQueue();
    this.renderLog(key, s);
  }

  /** Rebuild each part of the log only when what it shows changed, keeping the scroll position and the open tool chips. */
  private renderLog(key: string, s: ChatState): void {
    const log = this.body, turn = s.turn, idle = !s.rows.length && !turn;
    const loading = idle && !!s.sid && this.loaded.get(key) !== s.sid;
    // Rows past the turn's `after` are its own; they join the history when pull folds the turn. No `after`, no split.
    const after = turn?.after ?? null;
    const rows = after === null ? s.rows : s.rows.filter(row => row.id <= after);
    const sig = `${key}\n${JSON.stringify([rows.length, rows.at(-1)?.id, loading])}`;
    const turnSig = `${key}\n${JSON.stringify(turn && [turn.done, turn.code, turn.error, turn.sid, turn.tools.length, turn.tools.filter(t => t.output !== null).length])}`;
    if (sig === this.sig && turnSig === this.turnSig) return;
    const same = this.sig.startsWith(`${key}\n`);
    const stick = !same || log.scrollHeight - log.scrollTop - log.clientHeight < 4;
    const top = log.scrollTop;
    const open = same ? Array.from(log.querySelectorAll<HTMLDetailsElement>("details.hm-chat-tool"), d => d.open) : [];
    if (idle) {
      this.sig = sig;
      this.turnSig = turnSig;
      this.live = null;
      this.removeChild(this.md);
      this.removeChild(this.turnMd);
      if (loading) super.empty("loader", "Loading…");
      else super.empty("message-square", `Ask ${this.profile} anything`);
      return;
    }
    // An empty state replaced both parts.
    if (this.historyEl?.parentElement !== log || this.turnEl?.parentElement !== log) {
      log.empty();
      this.historyEl = log.createDiv("hm-chat-history");
      this.turnEl = log.createDiv("hm-chat-turn");
      this.sig = this.turnSig = "";
    }
    const history = this.historyEl, now = this.turnEl;
    const renders: Promise<void>[] = [];
    const markdown = (el: HTMLElement, owner: Component, text: string) => { renders.push(renderSafe(this.app, text, el.createDiv("hm-doc markdown-rendered"), owner)); };
    if (sig !== this.sig) {
      this.sig = sig;
      history.empty();
      this.removeChild(this.md);
      this.md = this.addChild(new Component());
      // Tool-only rows fold into one muted line before the next text; a turn streamed here shows its chips and footer instead.
      let calls: string[] = [], usage: Usage | undefined;
      const flush = () => { if (calls.length) stat(history, "wrench", calls.join(", "), "Tool calls", "is-muted"); calls = []; };
      for (const row of rows) {
        if (row.role === "user") {
          flush();
          if (usage) foot(history, usage);
          const extra = s.extras[row.id], call = userInvocation(row.text, extra?.skill);
          if (call) skillBlock(history, call); else history.createDiv({ cls: "hm-chat-user", text: row.text });
          if (extra) chips(history, extra.tools);
          usage = extra?.usage;
        } else {
          if (row.text) { flush(); markdown(history, this.md, row.text); }
          if (row.tools && !usage) calls.push(row.tools);
        }
      }
      flush();
      if (usage) foot(history, usage);
    }
    if (turnSig !== this.turnSig) {
      this.turnSig = turnSig;
      now.empty();
      this.removeChild(this.turnMd);
      this.turnMd = this.addChild(new Component());
      this.live = null;
      if (turn) {
        const call = userInvocation(turn.user, turn.skill);
        if (call) skillBlock(now, call, !turn.done ? "running" : turn.code === 0 ? "done" : "failed"); else now.createDiv({ cls: "hm-chat-user", text: turn.user });
        chips(now, turn.tools);
        if (!turn.done) this.live = now.createDiv("hm-chat-live").appendChild(now.doc.createTextNode(turn.text));
        else if (turn.text) markdown(now, this.turnMd, turn.text);
        if (turn.done) outcome(now, turn, s, this.profile);
        if (turn.usage) foot(now, turn.usage);
      }
    }
    log.querySelectorAll<HTMLDetailsElement>("details.hm-chat-tool").forEach((d, i) => { d.open = open[i] ?? false; });
    log.scrollTop = stick ? log.scrollHeight : top;
    // Settled every time, so a failed render is never an unhandled rejection.
    void Promise.allSettled(renders).then(() => { if (stick && this.sig === sig && this.turnSig === turnSig) log.scrollTop = log.scrollHeight; });
  }
}
