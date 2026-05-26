// In-process registry of ChannelKind adapter factories. Adapters self-register
// by importing this module and calling `register()` from their entry file.

import type { ChannelKindDescriptor } from "./types.js";

const kinds = new Map<string, ChannelKindDescriptor>();

export function register(desc: ChannelKindDescriptor): void {
  if (kinds.has(desc.kind)) {
    throw new Error(`[channels/registry] kind already registered: ${desc.kind}`);
  }
  kinds.set(desc.kind, desc);
}

export function getKind(kind: string): ChannelKindDescriptor | undefined {
  return kinds.get(kind);
}

export function listKinds(): ChannelKindDescriptor[] {
  return [...kinds.values()];
}

// Test helper — clears all registered kinds.
export function _resetRegistry(): void {
  kinds.clear();
}
