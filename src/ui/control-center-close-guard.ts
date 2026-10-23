export interface GuardedLeaf { detach(): void }
export function guardControlCenterClose(leaf: GuardedLeaf, requestClose: () => Promise<boolean>, onError: (error: unknown) => void, detached: () => Promise<void> = async () => undefined) {
  const descriptor = Object.getOwnPropertyDescriptor(leaf, "detach");
  const original = leaf.detach;
  let pending: Promise<boolean> | null = null;
  let active = true;
  const close = (): Promise<boolean> => {
    if (pending) return pending;
    if (!active) return Promise.resolve(false);
    pending = (async () => {
      try {
        if (!await requestClose() || !active) return false;
        original.call(leaf);
        await detached();
        return true;
      } finally { pending = null; }
    })();
    return pending;
  };
  const guarded = (): void => { void close().catch(onError); };
  leaf.detach = guarded;
  return {
    close,
    restore: (): void => {
      active = false;
      if (leaf.detach !== guarded) return;
      if (descriptor) Object.defineProperty(leaf, "detach", descriptor);
      else Reflect.deleteProperty(leaf, "detach");
    },
  };
}
