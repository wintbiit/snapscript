import type { ComponentRecord } from "./records";

export interface ComponentStorage {
  hasEntity(entityId: number): boolean;
  addEntity(entityId: number): void;
  deleteEntity(entityId: number): boolean;
  entities(): Iterable<number>;
  entityIds(): readonly number[];
  queryRows(componentIds: readonly number[]): Iterable<ComponentQueryRow>;
  forEachRow(componentIds: readonly number[], visitor: ComponentRowVisitor): void;
  countRows(componentIds: readonly number[]): number;
  componentSize(componentId: number): number;
  get(entityId: number, componentId: number): ComponentRecord | undefined;
  first(entityId: number): ComponentRecord | undefined;
  set(entityId: number, componentId: number, record: ComponentRecord): void;
  remove(entityId: number, componentId: number): boolean;
  records(): readonly ComponentRecord[];
}

export interface ComponentQueryRow {
  readonly entityId: number;
  readonly first?: ComponentRecord;
  readonly second?: ComponentRecord;
  readonly third?: ComponentRecord;
  readonly fourth?: ComponentRecord;
  readonly records?: readonly ComponentRecord[];
}

export type ComponentRowVisitor = (
  entityId: number,
  first?: ComponentRecord,
  second?: ComponentRecord,
  third?: ComponentRecord,
  fourth?: ComponentRecord,
  records?: readonly ComponentRecord[],
) => void;

interface ComponentTable {
  readonly denseEntities: number[];
  readonly denseRecords: ComponentRecord[];
  readonly sparseEntityToRow: Map<number, number>;
}

interface ArchetypeBucket {
  readonly signature: string;
  readonly componentIds: readonly number[];
  readonly entities: Set<number>;
  addTransitions?: Map<number, ArchetypeBucket>;
  removeTransitions?: Map<number, ArchetypeBucket>;
}

export class MapComponentStorage implements ComponentStorage {
  readonly #entities = new Set<number>();
  readonly #recordsByEntity = new Map<number, Map<number, ComponentRecord>>();

  hasEntity(entityId: number): boolean {
    return this.#entities.has(entityId);
  }

  addEntity(entityId: number): void {
    this.#entities.add(entityId);
  }

  deleteEntity(entityId: number): boolean {
    if (!this.#entities.delete(entityId)) {
      return false;
    }
    this.#recordsByEntity.delete(entityId);
    return true;
  }

  entities(): Iterable<number> {
    return this.#entities.values();
  }

  entityIds(): readonly number[] {
    return [...this.#entities].sort((a, b) => a - b);
  }

  queryRows(componentIds: readonly number[]): Iterable<ComponentQueryRow> {
    const storage = this;
    return {
      *[Symbol.iterator]() {
        for (const entityId of storage.#entities) {
          const row = storage.#queryRowFor(entityId, componentIds);
          if (row !== undefined) {
            yield row;
          }
        }
      },
    };
  }

  forEachRow(componentIds: readonly number[], visitor: ComponentRowVisitor): void {
    for (const entityId of this.#entities) {
      this.#visitRecords(entityId, componentIds, visitor);
    }
  }

  countRows(componentIds: readonly number[]): number {
    let count = 0;
    for (const entityId of this.query(componentIds)) {
      count += entityId >= 0 ? 1 : 0;
    }
    return count;
  }

  query(componentIds: readonly number[]): Iterable<number> {
    const storage = this;
    return {
      *[Symbol.iterator]() {
        for (const entityId of storage.#entities) {
          const records = storage.#recordsByEntity.get(entityId);
          if (
            componentIds.every((componentId) => records?.has(componentId) === true)
          ) {
            yield entityId;
          }
        }
      },
    };
  }

  componentSize(componentId: number): number {
    let count = 0;
    for (const records of this.#recordsByEntity.values()) {
      if (records.has(componentId)) {
        count += 1;
      }
    }
    return count;
  }

  get(entityId: number, componentId: number): ComponentRecord | undefined {
    return this.#recordsByEntity.get(entityId)?.get(componentId);
  }

  first(entityId: number): ComponentRecord | undefined {
    return this.#recordsByEntity.get(entityId)?.values().next().value;
  }

  set(entityId: number, componentId: number, record: ComponentRecord): void {
    this.addEntity(entityId);
    let records = this.#recordsByEntity.get(entityId);
    if (records === undefined) {
      records = new Map<number, ComponentRecord>();
      this.#recordsByEntity.set(entityId, records);
    }
    records.set(componentId, record);
  }

  remove(entityId: number, componentId: number): boolean {
    const records = this.#recordsByEntity.get(entityId);
    if (records === undefined) {
      return false;
    }
    const removed = records.delete(componentId);
    if (records.size === 0) {
      this.#recordsByEntity.delete(entityId);
    }
    return removed;
  }

  records(): readonly ComponentRecord[] {
    return [...this.#recordsByEntity.values()]
      .flatMap((records) => [...records.values()])
      .sort((a, b) => a.entityId - b.entityId || a.schema.schemaId - b.schema.schemaId);
  }

  #queryRowFor(
    entityId: number,
    componentIds: readonly number[],
  ): ComponentQueryRow | undefined {
    if (componentIds.length === 0) {
      return { entityId };
    }

    const maybeRecords = componentIds.map((componentId) => this.get(entityId, componentId));
    if (maybeRecords.some((record) => record === undefined)) {
      return undefined;
    }
    const records = maybeRecords as ComponentRecord[];

    if (componentIds.length === 1) {
      return { entityId, first: records[0]! };
    }
    if (componentIds.length === 2) {
      return { entityId, first: records[0]!, second: records[1]! };
    }
    if (componentIds.length === 3) {
      return { entityId, first: records[0]!, second: records[1]!, third: records[2]! };
    }
    if (componentIds.length === 4) {
      return {
        entityId,
        first: records[0]!,
        second: records[1]!,
        third: records[2]!,
        fourth: records[3]!,
      };
    }

    return { entityId, records: records as readonly ComponentRecord[] };
  }

  #visitRecords(
    entityId: number,
    componentIds: readonly number[],
    visitor: ComponentRowVisitor,
  ): void {
    const row = this.#queryRowFor(entityId, componentIds);
    if (row !== undefined) {
      visitor(entityId, row.first, row.second, row.third, row.fourth, row.records);
    }
  }
}

class ArchetypeIndex {
  readonly #bucketByEntity = new Map<number, ArchetypeBucket>();
  readonly #bucketsBySignature = new Map<string, ArchetypeBucket>();
  readonly #matchingBucketsByQuery = new Map<string, readonly ArchetypeBucket[]>();

  removeEntity(entityId: number): void {
    const bucket = this.#bucketByEntity.get(entityId);
    if (bucket === undefined) {
      return;
    }

    this.#bucketByEntity.delete(entityId);
    this.#removeFromBucket(entityId, bucket);
  }

  addComponent(entityId: number, componentId: number, components: ReadonlySet<number>): void {
    const previous = this.#bucketByEntity.get(entityId);
    if (previous === undefined) {
      if (components.size < 2) {
        return;
      }
      this.#addToBucket(entityId, this.#bucketFor(initialComponentIds(componentId, components)));
      return;
    }

    if (componentIdsInclude(previous.componentIds, componentId)) {
      return;
    }

    this.#moveToBucket(entityId, previous, this.#bucketAfterAdd(previous, componentId));
  }

  removeComponent(entityId: number, componentId: number): void {
    const previous = this.#bucketByEntity.get(entityId);
    if (previous === undefined) {
      return;
    }
    if (!componentIdsInclude(previous.componentIds, componentId)) {
      return;
    }

    if (previous.componentIds.length === 2) {
      this.removeEntity(entityId);
      return;
    }

    this.#moveToBucket(entityId, previous, this.#bucketAfterRemove(previous, componentId));
  }

  #bucketFor(componentIds: readonly number[]): ArchetypeBucket {
    const signature = signatureOf(componentIds);
    let bucket = this.#bucketsBySignature.get(signature);
    if (bucket === undefined) {
      bucket = {
        signature,
        componentIds,
        entities: new Set<number>(),
      };
      this.#bucketsBySignature.set(signature, bucket);
      this.#matchingBucketsByQuery.clear();
    }
    return bucket;
  }

  #bucketAfterAdd(bucket: ArchetypeBucket, componentId: number): ArchetypeBucket {
    // Component churn commonly repeats the same signatures; cache transitions after the first lookup.
    let transitions = bucket.addTransitions;
    if (transitions === undefined) {
      transitions = new Map<number, ArchetypeBucket>();
      bucket.addTransitions = transitions;
    }
    let next = transitions.get(componentId);
    if (next === undefined) {
      next = this.#bucketFor(insertComponentId(bucket.componentIds, componentId));
      transitions.set(componentId, next);
    }
    return next;
  }

  #bucketAfterRemove(bucket: ArchetypeBucket, componentId: number): ArchetypeBucket {
    let transitions = bucket.removeTransitions;
    if (transitions === undefined) {
      transitions = new Map<number, ArchetypeBucket>();
      bucket.removeTransitions = transitions;
    }
    let next = transitions.get(componentId);
    if (next === undefined) {
      next = this.#bucketFor(removeComponentId(bucket.componentIds, componentId));
      transitions.set(componentId, next);
    }
    return next;
  }

  #moveToBucket(entityId: number, previous: ArchetypeBucket, next: ArchetypeBucket): void {
    this.#removeFromBucket(entityId, previous);
    this.#addToBucket(entityId, next);
  }

  #addToBucket(entityId: number, bucket: ArchetypeBucket): void {
    this.#bucketByEntity.set(entityId, bucket);
    bucket.entities.add(entityId);
  }

  #removeFromBucket(entityId: number, bucket: ArchetypeBucket): void {
    // Keep empty buckets so repeated component churn can reuse signature query caches.
    bucket.entities.delete(entityId);
  }

  query(componentIds: readonly number[]): Iterable<number> {
    const buckets = this.#matchingBuckets(componentIds);

    return {
      *[Symbol.iterator]() {
        for (const bucket of buckets) {
          yield* bucket.entities;
        }
      }
    };
  }

  count(componentIds: readonly number[]): number {
    let count = 0;
    for (const bucket of this.#matchingBuckets(componentIds)) {
      count += bucket.entities.size;
    }
    return count;
  }

  #matchingBuckets(componentIds: readonly number[]): readonly ArchetypeBucket[] {
    const querySignature = signatureOf(componentIds);
    const cached = this.#matchingBucketsByQuery.get(querySignature);
    if (cached !== undefined) {
      return cached;
    }

    // Matching is cached per query signature and only invalidated when a new archetype signature appears.
    const required = [...componentIds].sort((a, b) => a - b);
    const buckets: ArchetypeBucket[] = [];
    for (const bucket of this.#bucketsBySignature.values()) {
      if (componentIdsContain(bucket.componentIds, required)) {
        buckets.push(bucket);
      }
    }
    this.#matchingBucketsByQuery.set(querySignature, buckets);
    return buckets;
  }
}

export interface SparseSetComponentStorageOptions {
  readonly archetypeIndex?: boolean;
}

export class SparseSetComponentStorage implements ComponentStorage {
  readonly #entities = new Set<number>();
  readonly #componentsByEntity = new Map<number, Set<number>>();
  readonly #tables = new Map<number, ComponentTable>();
  readonly #archetypes: ArchetypeIndex | undefined;

  constructor(options: SparseSetComponentStorageOptions = {}) {
    this.#archetypes = options.archetypeIndex === false ? undefined : new ArchetypeIndex();
  }

  hasEntity(entityId: number): boolean {
    return this.#entities.has(entityId);
  }

  addEntity(entityId: number): void {
    if (this.#entities.has(entityId)) {
      return;
    }
    this.#entities.add(entityId);
    const components = new Set<number>();
    this.#componentsByEntity.set(entityId, components);
  }

  deleteEntity(entityId: number): boolean {
    if (!this.#entities.has(entityId)) {
      return false;
    }

    for (const componentId of [...(this.#componentsByEntity.get(entityId) ?? [])]) {
      this.#removeRecord(entityId, componentId);
    }
    this.#entities.delete(entityId);
    this.#componentsByEntity.delete(entityId);
    this.#archetypes?.removeEntity(entityId);
    return true;
  }

  entities(): Iterable<number> {
    return this.#entities.values();
  }

  entityIds(): readonly number[] {
    return [...this.#entities].sort((a, b) => a - b);
  }

  queryRows(componentIds: readonly number[]): Iterable<ComponentQueryRow> {
    if (componentIds.length === 0) {
      return this.#entityRows();
    }
    if (componentIds.length === 1) {
      // Single-component queries are pure dense-table scans.
      return this.#singleComponentRows(componentIds[0]!);
    }
    if (componentIds.length === 2) {
      // Pair queries stay on sparse-set lookup; this avoids archetype overhead in the common dense-pair case.
      return this.#sparsePairRows(componentIds, this.#smallestComponent(componentIds));
    }

    // Wider queries choose between the archetype index and the smallest sparse table at execution time.
    const smallestComponentId = this.#smallestComponent(componentIds);
    const smallestSize = this.componentSize(smallestComponentId);
    const archetypeSize = this.#archetypeCount(componentIds);
    if (archetypeSize < smallestSize) {
      return this.#archetypeRows(componentIds);
    }

    return this.#sparseRows(componentIds, smallestComponentId);
  }

  forEachRow(componentIds: readonly number[], visitor: ComponentRowVisitor): void {
    if (componentIds.length === 0) {
      for (const entityId of this.#entities) {
        visitor(entityId);
      }
      return;
    }

    if (componentIds.length === 1) {
      const table = this.#table(componentIds[0]!);
      for (const record of table.denseRecords) {
        visitor(record.entityId, record);
      }
      return;
    }

    if (componentIds.length === 2) {
      this.#forEachSparsePairRow(componentIds, this.#smallestComponent(componentIds), visitor);
      return;
    }

    const smallestComponentId = this.#smallestComponent(componentIds);
    const smallestSize = this.componentSize(smallestComponentId);
    const archetypeSize = this.#archetypeCount(componentIds);
    const entityIds =
      archetypeSize < smallestSize
        ? this.#archetypes!.query(componentIds)
        : this.#table(smallestComponentId).denseEntities;

    for (const entityId of entityIds) {
      this.#visitRecords(entityId, componentIds, visitor);
    }
  }

  countRows(componentIds: readonly number[]): number {
    if (componentIds.length === 0) {
      return this.#entities.size;
    }
    if (componentIds.length === 1) {
      return this.componentSize(componentIds[0]!);
    }

    const archetypeCount = this.#archetypeCount(componentIds);
    return Number.isFinite(archetypeCount) ? archetypeCount : this.#sparseCount(componentIds);
  }

  componentSize(componentId: number): number {
    return this.#tables.get(componentId)?.denseEntities.length ?? 0;
  }

  get(entityId: number, componentId: number): ComponentRecord | undefined {
    const table = this.#tables.get(componentId);
    const row = table?.sparseEntityToRow.get(entityId);
    return row === undefined ? undefined : table?.denseRecords[row];
  }

  first(entityId: number): ComponentRecord | undefined {
    const componentId = this.#componentsByEntity.get(entityId)?.values().next().value;
    return componentId === undefined ? undefined : this.get(entityId, componentId);
  }

  set(entityId: number, componentId: number, record: ComponentRecord): void {
    this.addEntity(entityId);
    const table = this.#table(componentId);
    const existingRow = table.sparseEntityToRow.get(entityId);
    if (existingRow !== undefined) {
      table.denseRecords[existingRow] = record;
      return;
    }

    const row = table.denseEntities.length;
    table.denseEntities.push(entityId);
    table.denseRecords.push(record);
    table.sparseEntityToRow.set(entityId, row);
    const components = this.#componentSet(entityId);
    const previousSize = components.size;
    components.add(componentId);
    if (components.size >= 2 && components.size !== previousSize) {
      this.#archetypes?.addComponent(entityId, componentId, components);
    }
  }

  remove(entityId: number, componentId: number): boolean {
    const removed = this.#removeRecord(entityId, componentId);
    if (!removed) {
      return false;
    }

    const components = this.#componentSet(entityId);
    const previousSize = components.size;
    components.delete(componentId);
    if (previousSize >= 2) {
      this.#archetypes?.removeComponent(entityId, componentId);
    }
    return true;
  }

  records(): readonly ComponentRecord[] {
    return [...this.#tables.values()]
      .flatMap((table) => table.denseRecords)
      .sort((a, b) => a.entityId - b.entityId || a.schema.schemaId - b.schema.schemaId);
  }

  #removeRecord(entityId: number, componentId: number): boolean {
    const table = this.#tables.get(componentId);
    const row = table?.sparseEntityToRow.get(entityId);
    if (table === undefined || row === undefined) {
      return false;
    }

    const lastRow = table.denseEntities.length - 1;
    const lastEntityId = table.denseEntities[lastRow]!;
    const lastRecord = table.denseRecords[lastRow]!;

    if (row !== lastRow) {
      table.denseEntities[row] = lastEntityId;
      table.denseRecords[row] = lastRecord;
      table.sparseEntityToRow.set(lastEntityId, row);
    }

    table.denseEntities.pop();
    table.denseRecords.pop();
    table.sparseEntityToRow.delete(entityId);
    return true;
  }

  #table(componentId: number): ComponentTable {
    const existing = this.#tables.get(componentId);
    if (existing !== undefined) {
      return existing;
    }

    const table = {
      denseEntities: [],
      denseRecords: [],
      sparseEntityToRow: new Map<number, number>(),
    };
    this.#tables.set(componentId, table);
    return table;
  }

  #smallestComponent(componentIds: readonly number[]): number {
    // Sparse-set planning starts from the smallest dense table to minimize membership checks.
    let smallest = componentIds[0]!;
    let smallestSize = this.componentSize(smallest);
    for (let index = 1; index < componentIds.length; index += 1) {
      const componentId = componentIds[index]!;
      const size = this.componentSize(componentId);
      if (size < smallestSize) {
        smallest = componentId;
        smallestSize = size;
      }
    }
    return smallest;
  }

  #archetypeCount(componentIds: readonly number[]): number {
    return this.#archetypes?.count(componentIds) ?? Number.POSITIVE_INFINITY;
  }

  #sparseCount(componentIds: readonly number[]): number {
    const smallestComponentId = this.#smallestComponent(componentIds);
    let count = 0;
    for (const entityId of this.#table(smallestComponentId).denseEntities) {
      if (componentIds.every((componentId) => this.get(entityId, componentId) !== undefined)) {
        count += 1;
      }
    }
    return count;
  }

  #entityRows(): Iterable<ComponentQueryRow> {
    const storage = this;
    return {
      *[Symbol.iterator]() {
        for (const entityId of storage.#entities) {
          yield { entityId };
        }
      },
    };
  }

  #singleComponentRows(componentId: number): Iterable<ComponentQueryRow> {
    const table = this.#table(componentId);
    return {
      *[Symbol.iterator]() {
        for (const record of table.denseRecords) {
          yield { entityId: record.entityId, first: record };
        }
      },
    };
  }

  #archetypeRows(componentIds: readonly number[]): Iterable<ComponentQueryRow> {
    const storage = this;
    const archetypes = this.#archetypes;
    if (archetypes === undefined) {
      return this.#sparseRows(componentIds, this.#smallestComponent(componentIds));
    }
    return {
      *[Symbol.iterator]() {
        for (const entityId of archetypes.query(componentIds)) {
          const row = storage.#queryRowFor(entityId, componentIds);
          if (row !== undefined) {
            yield row;
          }
        }
      },
    };
  }

  #sparsePairRows(
    componentIds: readonly number[],
    candidateComponentId: number,
  ): Iterable<ComponentQueryRow> {
    const storage = this;
    return {
      *[Symbol.iterator]() {
        const candidateTable = storage.#table(candidateComponentId);
        for (let row = 0; row < candidateTable.denseEntities.length; row += 1) {
          const entityId = candidateTable.denseEntities[row]!;
          const candidateRecord = candidateTable.denseRecords[row]!;
          const first =
            candidateComponentId === componentIds[0]!
              ? candidateRecord
              : storage.get(entityId, componentIds[0]!);
          const second =
            candidateComponentId === componentIds[1]!
              ? candidateRecord
              : storage.get(entityId, componentIds[1]!);
          if (first !== undefined && second !== undefined) {
            yield { entityId, first, second };
          }
        }
      },
    };
  }

  #forEachSparsePairRow(
    componentIds: readonly number[],
    candidateComponentId: number,
    visitor: ComponentRowVisitor,
  ): void {
    const candidateTable = this.#table(candidateComponentId);
    for (let row = 0; row < candidateTable.denseEntities.length; row += 1) {
      const entityId = candidateTable.denseEntities[row]!;
      const candidateRecord = candidateTable.denseRecords[row]!;
      const first =
        candidateComponentId === componentIds[0]!
          ? candidateRecord
          : this.get(entityId, componentIds[0]!);
      const second =
        candidateComponentId === componentIds[1]!
          ? candidateRecord
          : this.get(entityId, componentIds[1]!);
      if (first !== undefined && second !== undefined) {
        visitor(entityId, first, second);
      }
    }
  }

  #sparseRows(
    componentIds: readonly number[],
    candidateComponentId: number,
  ): Iterable<ComponentQueryRow> {
    const storage = this;
    return {
      *[Symbol.iterator]() {
        const candidateTable = storage.#table(candidateComponentId);
        for (const entityId of candidateTable.denseEntities) {
          const row = storage.#queryRowFor(entityId, componentIds);
          if (row === undefined) {
            continue;
          }
          yield row;
        }
      },
    };
  }

  #queryRowFor(
    entityId: number,
    componentIds: readonly number[],
  ): ComponentQueryRow | undefined {
    const first = this.get(entityId, componentIds[0]!);
    const second = this.get(entityId, componentIds[1]!);
    const third = this.get(entityId, componentIds[2]!);
    if (first === undefined || second === undefined || third === undefined) {
      return undefined;
    }

    if (componentIds.length === 3) {
      return { entityId, first, second, third };
    }

    const fourth = this.get(entityId, componentIds[3]!);
    if (fourth === undefined) {
      return undefined;
    }

    if (componentIds.length === 4) {
      return { entityId, first, second, third, fourth };
    }

    const records = this.#recordsFor(entityId, componentIds);
    return records === undefined ? undefined : { entityId, records };
  }

  #visitRecords(
    entityId: number,
    componentIds: readonly number[],
    visitor: ComponentRowVisitor,
  ): void {
    const first = this.get(entityId, componentIds[0]!);
    const second = this.get(entityId, componentIds[1]!);
    const third = this.get(entityId, componentIds[2]!);
    if (first === undefined || second === undefined || third === undefined) {
      return;
    }

    if (componentIds.length === 3) {
      visitor(entityId, first, second, third);
      return;
    }

    const fourth = this.get(entityId, componentIds[3]!);
    if (fourth === undefined) {
      return;
    }

    if (componentIds.length === 4) {
      visitor(entityId, first, second, third, fourth);
      return;
    }

    const records = this.#recordsFor(entityId, componentIds);
    if (records !== undefined) {
      visitor(entityId, undefined, undefined, undefined, undefined, records);
    }
  }

  #recordsFor(
    entityId: number,
    componentIds: readonly number[],
  ): readonly ComponentRecord[] | undefined {
    const records: ComponentRecord[] = [];
    for (const componentId of componentIds) {
      const record = this.get(entityId, componentId);
      if (record === undefined) {
        return undefined;
      }
      records.push(record);
    }
    return records;
  }

  #componentSet(entityId: number): Set<number> {
    const existing = this.#componentsByEntity.get(entityId);
    if (existing !== undefined) {
      return existing;
    }
    const set = new Set<number>();
    this.#componentsByEntity.set(entityId, set);
    return set;
  }
}

function sortedComponentIds(components: ReadonlySet<number>): readonly number[] {
  return [...components].sort((a, b) => a - b);
}

function initialComponentIds(componentId: number, components: ReadonlySet<number>): readonly number[] {
  if (components.size === 2) {
    for (const other of components) {
      if (other !== componentId) {
        return other < componentId ? [other, componentId] : [componentId, other];
      }
    }
  }
  return sortedComponentIds(components);
}

function insertComponentId(componentIds: readonly number[], componentId: number): readonly number[] {
  const result: number[] = [];
  let inserted = false;

  for (const current of componentIds) {
    if (current === componentId) {
      return componentIds;
    }
    if (!inserted && componentId < current) {
      result.push(componentId);
      inserted = true;
    }
    result.push(current);
  }

  if (!inserted) {
    result.push(componentId);
  }
  return result;
}

function removeComponentId(componentIds: readonly number[], componentId: number): readonly number[] {
  const result: number[] = [];
  for (const current of componentIds) {
    if (current !== componentId) {
      result.push(current);
    }
  }
  return result;
}

function signatureOf(componentIds: readonly number[]): string {
  return componentIds.join(",");
}

function componentIdsContain(available: readonly number[], required: readonly number[]): boolean {
  if (required.length === 0) {
    return true;
  }

  let requiredIndex = 0;
  let availableIndex = 0;

  while (requiredIndex < required.length && availableIndex < available.length) {
    const currentRequired = required[requiredIndex]!;
    const currentAvailable = available[availableIndex]!;
    if (currentAvailable === currentRequired) {
      requiredIndex += 1;
      availableIndex += 1;
    } else if (currentAvailable < currentRequired) {
      availableIndex += 1;
    } else {
      return false;
    }
  }

  return requiredIndex === required.length;
}

function componentIdsInclude(componentIds: readonly number[], componentId: number): boolean {
  for (const current of componentIds) {
    if (current === componentId) {
      return true;
    }
    if (current > componentId) {
      return false;
    }
  }
  return false;
}
