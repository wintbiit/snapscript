import type { ComponentSchema, FieldDefinitions } from "../schema/index";
import type { PeerId } from "../platform/index";
import type { DirtyGraph } from "./dirty-graph";
import type {
  ClientWorld,
  ComponentInstance,
  EntityRef,
  HostWorld,
} from "./world";
import type { ComponentRecord } from "./records";

export interface WorldInternals {
  getRecord(entityId: number, componentId?: number): ComponentRecord | undefined;
  getRecords(): readonly ComponentRecord[];
  getEntityIds(): readonly number[];
  getNetworkOwners(): readonly { readonly entityId: number; readonly owner: PeerId }[];
  getOwner(entityId: number): PeerId;
  getDirtySnapshot(): ReturnType<DirtyGraph["collectOps"]>;
  clearWrittenDirty(ops: ReturnType<DirtyGraph["collectOps"]>): void;
  getDirtyMask(entityId: number, componentId?: number): number;
  entityRef(entityId: number): EntityRef;
  spawnRemote<TFields extends FieldDefinitions>(
    component: ComponentSchema<TFields>,
    entityId: number,
  ): ComponentInstance<TFields>;
  applyCreateEntityFromRemote(entityId: number): void;
  applyNetworkFromRemote(entityId: number, owner: PeerId): void;
  applyRemoveFromRemote(entityId: number, componentId: number): void;
  applyDestroyFromRemote(entityId: number, schemaId?: number): void;
}

const internalsByWorld = new WeakMap<HostWorld | ClientWorld, WorldInternals>();

export function registerWorldInternals(
  world: HostWorld | ClientWorld,
  internals: WorldInternals,
): void {
  internalsByWorld.set(world, internals);
}

export function worldInternals(world: HostWorld | ClientWorld): WorldInternals {
  const internals = internalsByWorld.get(world);
  if (internals === undefined) {
    throw new Error("Unknown SnapScript world instance");
  }
  return internals;
}
