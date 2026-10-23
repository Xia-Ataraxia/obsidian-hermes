import { checkAlias } from "../domain/remote-token-validator";
import type { TargetChangeResult } from "../types/contracts";
import type { ViewerSettings } from "../types/snapshot";

interface TargetServices {
  settings(): ViewerSettings;
  close(alias: string): Promise<boolean>;
  cancel(alias: string): Promise<void>;
  save(settings: ViewerSettings): Promise<void>;
  forget(alias: string): Promise<void>;
}
export class ControlCenterTargets {
  private readonly pending = new Set<string>();
  private readonly generations = new Map<string, number>();
  private disposed = false;
  constructor(private readonly services: TargetServices) {}
  get active(): boolean { return !this.disposed; }
  generation(alias: string): number { return this.disposed ? -1 : this.generations.get(alias) ?? 0; }
  private validate(previous: string, target: string | null): TargetChangeResult | null {
    if (this.disposed) return { ok: false, reason: "cancelled" };
    const settings = this.services.settings();
    if (!settings.servers.includes(previous)) return { ok: false, reason: "unknown" };
    if (target === previous) return { ok: true, changed: false };
    if (target && settings.servers.includes(target)) return { ok: false, reason: "duplicate" };
    return null;
  }
  replace(previous: string, next: string): Promise<TargetChangeResult> {
    const target = next.trim();
    if (!checkAlias(target).ok) return Promise.resolve({ ok: false, reason: "invalid" });
    return this.change(previous, target);
  }
  remove(alias: string): Promise<TargetChangeResult> { return this.change(alias, null); }
  private async change(previous: string, target: string | null): Promise<TargetChangeResult> {
    const invalid = this.validate(previous, target);
    if (invalid) return invalid;
    if (this.pending.has(previous) || target && this.pending.has(target)) return { ok: false, reason: "cancelled" };
    this.pending.add(previous); if (target) this.pending.add(target);
    try {
      if (!await this.services.close(previous)) return { ok: false, reason: "cancelled" };
      const afterClose = this.validate(previous, target);
      if (afterClose) return afterClose;
      this.generations.set(previous, this.generation(previous) + 1);
      await this.services.cancel(previous);
      const afterCancel = this.validate(previous, target);
      if (afterCancel) return afterCancel;
      const settings = this.services.settings();
      await this.services.save({ ...settings,
        servers: target ? settings.servers.map(alias => alias === previous ? target : alias) : settings.servers.filter(alias => alias !== previous),
        selectedSources: settings.selectedSources.filter(key => !key.startsWith(`${previous}\u0000`)),
      });
      await this.services.forget(previous);
      return { ok: true, changed: true };
    } finally { this.pending.delete(previous); if (target) this.pending.delete(target); }
  }
  dispose(): void { this.disposed = true; }
}
