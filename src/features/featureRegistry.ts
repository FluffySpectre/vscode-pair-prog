import { Message } from "../network/protocol";
import { Feature, FeatureContext, FeatureCommand, SessionRole } from "./feature";

/**
 * Manages feature instances. Shared between host and client sessions.
 * Handles registration, lifecycle, and message routing.
 */
export class FeatureRegistry {
  private features: Map<string, Feature> = new Map();
  private messageRoutes: Map<string, string> = new Map();

  register(feature: Feature): void {
    if (this.features.has(feature.id)) {
      throw new Error(`Feature "${feature.id}" is already registered.`);
    }
    this.features.set(feature.id, feature);

    for (const msgType of feature.messageTypes) {
      if (this.messageRoutes.has(msgType)) {
        throw new Error(
          `Message type "${msgType}" is already claimed by feature "${this.messageRoutes.get(msgType)}".`
        );
      }
      this.messageRoutes.set(msgType, feature.id);
    }
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

  routeMessage(msg: Message): boolean {
    const featureId = this.messageRoutes.get(msg.type as string);
    if (!featureId) {
      return false;
    }
    const feature = this.features.get(featureId);
    if (!feature) {
      return false;
    }
    feature.handleMessage(msg);
    return true;
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
      feature.dispose();
    }
    this.features.clear();
    this.messageRoutes.clear();
  }
}
