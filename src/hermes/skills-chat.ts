/* Slash skills in the chat, as the Hermes CLI has them: `/name rest` picks a skill, and a stored invocation reads as `/name — rest`. */

/** Skill names as Hermes slugs them for `/commands`; plugin skills carry a `ns:` prefix. Never a leading "-", so it is safe in argv. */
export const SKILL_NAME = /^[\p{L}\p{N}_][\p{L}\p{N}_:.-]{0,79}$/u;
export interface Pick { readonly name: string; readonly description?: string }
export interface Invocation { readonly name: string; readonly instruction: string }

const slug = (name: string): string => name.trim().toLowerCase().replace(/\s+/g, "-");

/** `/name rest` where `name` is one of the skills; null for other text (including unknown slash commands). */
export function slashSkill(text: string, skills: readonly Pick[]): Invocation | null {
  const m = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!m) return null;
  const typed = slug(m[1] ?? "");
  const hit = skills.find(s => SKILL_NAME.test(s.name) && slug(s.name) === typed);
  return hit ? { name: hit.name, instruction: (m[2] ?? "").trim() } : null;
}

/** The prefix matches first, then the rest whose name or description holds the query; at most `limit`. */
export function matchSkills<T extends Pick>(skills: readonly T[], query: string, limit = 30): T[] {
  const q = slug(query);
  const byName = (a: T, b: T): number => a.name.localeCompare(b.name);
  const head = skills.filter(s => slug(s.name).startsWith(q)).sort(byName);
  const rest = q ? skills.filter(s => !slug(s.name).startsWith(q) && `${s.name} ${s.description ?? ""}`.toLowerCase().includes(q)).sort(byName) : [];
  return [...head, ...rest].slice(0, limit);
}

const INVOKED = /^\[IMPORTANT: The user has invoked the (?:"([^"]*)" skill|(.+?) skill bundle),/;
const SINGLE = "The user has provided the following instruction alongside the skill invocation: ";

/** The CLI stores a skill turn as a long scaffold with the skill body; this recovers `/name` and what the user typed (agent/skill_commands.py describe_skill_invocation). */
export function invocationOf(content: string): Invocation | null {
  const m = INVOKED.exec(content);
  if (!m) return null;
  const name = (m[1] ?? m[2] ?? "").trim();
  if (!name) return null;
  const cut = (marker: string, stop: string, at: number): string => {
    if (at < 0) return "";
    return (content.slice(at + marker.length).split(stop, 1)[0] ?? "").replace(/\s+/g, " ").trim();
  };
  const instruction = m[2] !== undefined
    ? cut("\nUser instruction: ", "\n\n[Loaded as part of the", content.indexOf("\nUser instruction: "))
    : cut(SINGLE, "\n\n[Runtime note:", content.lastIndexOf(SINGLE));
  return { name: name.replace(/^\//, ""), instruction };
}

/** What a skill turn without instruction asks; `--skills` only preloads, so the query itself must say something. */
export const askFor = (name: string): string => `Follow the "${name}" skill.`;

/** A user row as a skill turn: ours (`skill` known, the stored text is the query) or the CLI's (the scaffold). */
export function userInvocation(text: string, skill?: string): Invocation | null {
  if (skill) return { name: skill, instruction: text === askFor(skill) ? "" : text };
  return invocationOf(text);
}
