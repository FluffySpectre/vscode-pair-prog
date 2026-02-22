import { Feature, FeatureContext, FeatureCommand, SessionRole } from "./feature";
import { MessageRouter } from "../network/messageRouter";

/**
 * Manages feature instances. Shared between host and client sessions.
 */
export class FeatureRegistry {
  private features: Map<string, Feature> = new Map();
  private router: MessageRouter;

  constructor(router: MessageRouter) {
    this.router = router;
  }

  register(feature: Feature): void {
    if (this.features.has(feature.id)) {
      throw new Error(`Feature "${feature.id}" is already registered.`);
    }
    this.features.set(feature.id, feature);
    this.router.register(feature);
  }

  async activateAll(context: FeatureContext): Promise<void> {
    for (const feature of this.features.values()) {
      await feature.activate(context);
    }
  }

  deactivateAll(): void {
    for (const feature of this.features.values()) {
      feature.deactivate();
    }
  }

  getCommands(role?: SessionRole): FeatureCommand[] {
    const commands: FeatureCommand[] = [];
    for (const feature of this.features.values()) {
      for (const cmd of feature.getCommands()) {
        if (!role || cmd.roles.includes(role)) {
          commands.push(cmd);
        }
      }
    }
    return commands;
  }

  get<T extends Feature>(id: string): T | undefined {
    return this.features.get(id) as T | undefined;
  }

  disposeAll(): void {
    for (const feature of this.features.values()) {
      this.router.unregister(feature);
      feature.dispose();
    }
    this.features.clear();
  }
}
