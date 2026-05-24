import type { FieldMeta, InternalFieldMeta } from "../schema/index";

export interface NetRef<T> {
  value: T;
  readonly meta: FieldMeta<T>;
  peek(): T;
  set(value: T): void;
}

export interface ReadonlyNetRef<T> {
  readonly value: T;
  readonly meta: FieldMeta<T>;
  peek(): T;
}

export class NetRefImpl<T> implements NetRef<T> {
  readonly meta: FieldMeta<T>;
  readonly #internalMeta: InternalFieldMeta<T>;
  #value: T;

  constructor(
    meta: InternalFieldMeta<T>,
    initialValue: T,
    private readonly markDirty: (meta: FieldMeta<T>) => void,
  ) {
    this.#internalMeta = Object.freeze(meta);
    this.meta = publicMeta(this.#internalMeta);
    this.#value = snapshotValue(this.#internalMeta, initialValue);
  }

  get value(): T {
    return this.#value;
  }

  set value(value: T) {
    this.set(value);
  }

  peek(): T {
    return this.#value;
  }

  set(value: T): void {
    if (this.#internalMeta.codec.equals(this.#value, value)) {
      return;
    }

    this.#value = snapshotValue(this.#internalMeta, value);
    this.markDirty(this.meta);
  }

  setFromRemote(value: T): void {
    if (this.#internalMeta.codec.equals(this.#value, value)) {
      return;
    }

    this.#value = snapshotValue(this.#internalMeta, value);
  }
}

function publicMeta<T>(meta: InternalFieldMeta<T>): FieldMeta<T> {
  return Object.freeze(
    meta.metadata === undefined
      ? {
          entityId: meta.entityId,
          schemaId: meta.schemaId,
          schemaName: meta.schemaName,
          fieldId: meta.fieldId,
          fieldName: meta.fieldName,
          dirtyBit: meta.dirtyBit,
          defaultValue: meta.defaultValue,
        }
      : {
          entityId: meta.entityId,
          schemaId: meta.schemaId,
          schemaName: meta.schemaName,
          fieldId: meta.fieldId,
          fieldName: meta.fieldName,
          dirtyBit: meta.dirtyBit,
          defaultValue: meta.defaultValue,
          metadata: meta.metadata,
        },
  );
}

function snapshotValue<T>(meta: InternalFieldMeta<T>, value: T): T {
  meta.codec.validate?.(value);
  const clone = meta.codec.clone?.(value) ?? value;
  if (typeof clone === "object" && clone !== null) {
    return Object.freeze(clone);
  }
  return clone;
}
