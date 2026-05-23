export interface DirtySnapshot {
  readonly created: readonly number[];
  readonly added: readonly DirtyComponent[];
  readonly updated: readonly DirtyUpdate[];
  readonly removed: readonly DirtyComponent[];
  readonly destroyed: readonly number[];
}

export type DirtyOps = DirtySnapshot;

export interface DirtyUpdate {
  readonly entityId: number;
  readonly componentId: number;
  readonly fieldMask: number;
}

export interface DirtyComponent {
  readonly entityId: number;
  readonly componentId: number;
}

export class DirtyGraph {
  readonly #created = new Set<number>();
  readonly #added = new Map<string, DirtyComponent>();
  readonly #updated = new Map<string, DirtyUpdate>();
  readonly #removed = new Map<string, DirtyComponent>();
  readonly #destroyed = new Set<number>();

  markCreated(entityId: number): void {
    this.#created.add(entityId);
    this.#deleteEntityUpdates(entityId);
    this.#destroyed.delete(entityId);
  }

  markAdded(entityId: number, componentId: number): void {
    if (this.#destroyed.has(entityId)) {
      return;
    }
    this.#added.set(key(entityId, componentId), { entityId, componentId });
    this.#removed.delete(key(entityId, componentId));
  }

  markUpdated(entityId: number, componentId: number, fieldId: number): void {
    // Newly-created or newly-added components are already written in full, so field deltas are redundant.
    if (this.#created.has(entityId) || this.#destroyed.has(entityId)) {
      return;
    }
    if (this.#added.has(key(entityId, componentId))) {
      return;
    }

    const dirtyBit = 1 << fieldId;
    const updateKey = updateKeyOf(entityId, componentId);
    const existing = this.#updated.get(updateKey);
    this.#updated.set(updateKey, {
      entityId,
      componentId,
      fieldMask: (existing?.fieldMask ?? 0) | dirtyBit,
    });
  }

  markRemoved(entityId: number, componentId: number): void {
    const componentKey = key(entityId, componentId);
    if (this.#added.delete(componentKey)) {
      return;
    }
    this.#updated.delete(updateKeyOf(entityId, componentId));
    this.#removed.set(componentKey, { entityId, componentId });
  }

  markDestroyed(entityId: number): void {
    if (this.#created.delete(entityId)) {
      this.#deleteEntityUpdates(entityId);
      this.#deleteEntityComponents(this.#added, entityId);
      this.#deleteEntityComponents(this.#removed, entityId);
      this.#destroyed.delete(entityId);
      return;
    }

    this.#deleteEntityUpdates(entityId);
    this.#deleteEntityComponents(this.#added, entityId);
    this.#deleteEntityComponents(this.#removed, entityId);
    this.#destroyed.add(entityId);
  }

  collectOps(): DirtyOps {
    return {
      created: [...this.#created].sort((a, b) => a - b),
      added: [...this.#added.values()].sort(compareDirtyComponent),
      updated: [...this.#updated.values()].sort(compareDirtyUpdate),
      removed: [...this.#removed.values()].sort(compareDirtyComponent),
      destroyed: [...this.#destroyed].sort((a, b) => a - b),
    };
  }

  snapshot(): DirtySnapshot {
    return this.collectOps();
  }

  clearWritten(ops: DirtyOps): void {
    // Clear only the bits that were actually encoded. Writes that happen during encoding remain dirty.
    for (const entityId of ops.created) {
      this.#created.delete(entityId);
    }

    for (const op of ops.added) {
      this.#added.delete(key(op.entityId, op.componentId));
    }

    for (const op of ops.updated) {
      const updateKey = updateKeyOf(op.entityId, op.componentId);
      const current = this.#updated.get(updateKey);
      if (current === undefined) {
        continue;
      }

      const remainingMask = current.fieldMask & ~op.fieldMask;
      if (remainingMask === 0) {
        this.#updated.delete(updateKey);
      } else {
        this.#updated.set(updateKey, { ...current, fieldMask: remainingMask });
      }
    }

    for (const op of ops.removed) {
      this.#removed.delete(key(op.entityId, op.componentId));
    }

    for (const entityId of ops.destroyed) {
      this.#destroyed.delete(entityId);
    }
  }

  maskOf(entityId: number, componentId?: number): number {
    if (componentId !== undefined) {
      return this.#updated.get(updateKeyOf(entityId, componentId))?.fieldMask ?? 0;
    }

    let mask = 0;
    for (const update of this.#updated.values()) {
      if (update.entityId === entityId) {
        mask |= update.fieldMask;
      }
    }
    return mask;
  }

  clear(): void {
    this.#created.clear();
    this.#added.clear();
    this.#updated.clear();
    this.#removed.clear();
    this.#destroyed.clear();
  }

  #deleteEntityUpdates(entityId: number): void {
    for (const update of this.#updated.values()) {
      if (update.entityId === entityId) {
        this.#updated.delete(updateKeyOf(update.entityId, update.componentId));
      }
    }
  }

  #deleteEntityComponents(map: Map<string, DirtyComponent>, entityId: number): void {
    for (const component of map.values()) {
      if (component.entityId === entityId) {
        map.delete(key(component.entityId, component.componentId));
      }
    }
  }
}

function key(entityId: number, componentId: number): string {
  return `${entityId}:${componentId}`;
}

function updateKeyOf(entityId: number, componentId: number): string {
  return key(entityId, componentId);
}

function compareDirtyComponent(a: DirtyComponent, b: DirtyComponent): number {
  return a.entityId - b.entityId || a.componentId - b.componentId;
}

function compareDirtyUpdate(a: DirtyUpdate, b: DirtyUpdate): number {
  return a.entityId - b.entityId || a.componentId - b.componentId;
}
