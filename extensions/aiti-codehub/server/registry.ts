/**
 * Provider registry: built-ins + runtime registrations.
 *
 * The built-in list lives in providers/index.ts. A future third-party platform can be
 * shipped as its own extension and register through the server service
 * `aiti-codehub.provider` without editing this package.
 */
import type { ForgeProvider, ProviderDescriptor } from "./contract.ts";
import { describeProvider } from "./contract.ts";
import { BUILTIN_PROVIDERS } from "../providers/index.ts";

export class ForgeRegistry {
  private map = new Map<string, ForgeProvider>();

  constructor(initial: ForgeProvider[] = []) {
    for (const p of initial) this.register(p);
  }

  register(provider: ForgeProvider): void {
    if (!provider?.id) throw new Error("provider.id is required");
    if (provider.contract !== 1) throw new Error(`provider ${provider.id}: unsupported contract ${String(provider.contract)}`);
    this.map.set(String(provider.id), provider);
  }

  get(id: string | undefined): ForgeProvider | undefined {
    if (!id) return undefined;
    return this.map.get(String(id));
  }

  list(): ForgeProvider[] {
    return [...this.map.values()];
  }

  ids(): string[] {
    return [...this.map.keys()];
  }

  descriptors(): ProviderDescriptor[] {
    return this.list().map(describeProvider);
  }
}

export const registry = new ForgeRegistry(BUILTIN_PROVIDERS);

/** Expose the registration service; returns a disposer. */
export function provideRegistryService(services: { provide?: (key: string, impl: unknown) => () => void } | undefined): (() => void) | null {
  try {
    if (!services?.provide) return null;
    return services.provide("aiti-codehub.provider", {
      register: (p: ForgeProvider) => {
        registry.register(p);
        return () => {
          /* removal is intentionally unsupported: providers are additive for the process lifetime */
        };
      },
      list: () => registry.ids(),
    });
  } catch {
    return null;
  }
}
