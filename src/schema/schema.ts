import type {
  EntitySchema,
  EntityOptions,
  FieldDefinition,
  FieldDefinitions,
  FieldValue,
  InternalEntitySchema,
  InternalFieldDefinition,
  InternalSchemaField,
  ComponentMap,
  ComponentSchema,
  PrefabDefinition,
  SchemaCodec,
  SchemaField,
  SchemaInstanceLike,
} from "./types";
import { isFieldDefinition } from "./types";
import { stableHash32 } from "../utils/hash";
import { assertPlainObjectMap, isPlainObjectMap } from "../utils/object";

const MAX_FIELDS_PER_SCHEMA = 32;
const schemasById = new Map<number, ComponentSchema>();

export type SimpleEntityDefinition<TFields extends FieldDefinitions> = PrefabDefinition<{
  readonly state: ComponentSchema<TFields>;
}> & {
  readonly component: ComponentSchema<TFields>;
};

function isComponentSchema(value: unknown): value is ComponentSchema {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { readonly kind?: unknown }).kind === "component" &&
    typeof (value as { readonly schemaId?: unknown }).schemaId === "number"
  );
}

/** Defines a prefab from named components, or a simple entity with one generated primary component. */
export function defineEntity<TComponents extends ComponentMap>(
  name: string,
  components: TComponents,
  options?: EntityOptions,
): PrefabDefinition<TComponents>;
export function defineEntity<TFields extends FieldDefinitions>(
  name: string,
  fields: TFields,
  options?: EntityOptions,
): SimpleEntityDefinition<TFields>;
export function defineEntity(
  name: string,
  fieldsOrComponents: Record<string, FieldDefinition<unknown> | ComponentSchema>,
  options?: EntityOptions,
): PrefabDefinition {
  assertDefinitionName("Entity", name);
  assertDefinitionBody("Entity", name, fieldsOrComponents);
  assertEntityOptions("Entity", name, options);
  const fields = fieldsOrComponents;
  const values = Object.values(fields);
  if (values.every(isFieldDefinition)) {
    const component = defineComponent(name, fields as FieldDefinitions, options);
    return definePrefab(
      name,
      { state: component },
      options,
      component,
    ) as SimpleEntityDefinition<FieldDefinitions>;
  }

  if (values.every(isComponentSchema)) {
    return definePrefab(name, fields as unknown as ComponentMap, options);
  }

  throw new Error(`Entity "${name}" must be defined with either fields or components, not a mix`);
}

/** Defines a replicated component schema from SnapScript field helpers. */
export function defineComponent<TFields extends FieldDefinitions>(
  name: string,
  fields: TFields,
  options?: EntityOptions,
): ComponentSchema<TFields> {
  assertDefinitionName("Component", name);
  assertDefinitionBody("Component", name, fields);
  assertEntityOptions("Component", name, options);
  const entries = Object.entries(fields) as [keyof TFields & string, FieldDefinition<unknown>][];

  if (entries.length > MAX_FIELDS_PER_SCHEMA) {
    throw new RangeError(
      `Schema "${name}" declares ${entries.length} fields; v0 supports at most ${MAX_FIELDS_PER_SCHEMA}`,
    );
  }

  const schemaId = idOrStableHash("Component", name, options?.id, `component:${name}`);

  const schemaFields: Record<string, InternalSchemaField<unknown>> = {};
  const fieldList: InternalSchemaField<unknown>[] = [];

  entries.forEach(([fieldName, definition], fieldId) => {
    if (!isFieldDefinition(definition)) {
      throw new Error(`Component "${name}" field "${fieldName}" must be created by a SnapScript field helper`);
    }
    const internalDefinition = definition as InternalFieldDefinition<unknown>;
    const schemaField = Object.freeze(
      definition.metadata === undefined
        ? {
            fieldId,
            fieldName,
            dirtyBit: 1 << fieldId,
            codec: internalDefinition.codec,
            defaultValue: definition.defaultValue,
          }
        : {
            fieldId,
            fieldName,
            dirtyBit: 1 << fieldId,
            codec: internalDefinition.codec,
            defaultValue: definition.defaultValue,
            metadata: definition.metadata,
          },
    );
    schemaFields[fieldName] = schemaField;
    fieldList.push(schemaField);
  });

  const frozenFields = Object.freeze(schemaFields) as InternalEntitySchema<TFields>["fields"];
  const frozenFieldList = Object.freeze(fieldList) as InternalSchemaField<FieldValue<TFields[keyof TFields]>>[];
  const codec = Object.freeze(createSchemaCodec(frozenFieldList));
  const base: InternalEntitySchema<TFields> = {
    kind: "component" as const,
    name,
    schemaId,
    fields: frozenFields,
    fieldList: frozenFieldList,
    fieldCount: entries.length,
    fullMask: entries.length === 32 ? 0xffffffff : (1 << entries.length) - 1,
    codec,
  };
  const schema: InternalEntitySchema<TFields> =
    Object.freeze(
      options?.metadata === undefined
        ? base
        : { ...base, metadata: freezeMetadata(options.metadata) },
    );

  if (!schemasById.has(schemaId)) {
    schemasById.set(schemaId, schema as ComponentSchema);
  }
  return schema;
}

function definePrefab<TComponents extends ComponentMap>(
  name: string,
  components: TComponents,
  options?: EntityOptions,
  component?: TComponents[keyof TComponents],
): PrefabDefinition<TComponents> {
  const frozenComponents = Object.freeze({ ...components }) as TComponents;
  const componentList = Object.freeze(Object.values(frozenComponents)) as TComponents[keyof TComponents][];
  const primary = component ?? (componentList.length === 1 ? componentList[0] : undefined);
  const base = {
    kind: "prefab" as const,
    name,
    prefabId: idOrStableHash("Prefab", name, options?.id, `prefab:${name}`),
    components: frozenComponents,
    componentList,
  };
  const withPrimary = primary === undefined ? base : { ...base, component: primary };

  return Object.freeze(
    options?.metadata === undefined
      ? withPrimary
      : { ...withPrimary, metadata: freezeMetadata(options.metadata) },
  );
}

function freezeMetadata(metadata: Record<string, unknown>): Readonly<Record<string, unknown>> {
  assertPlainObjectMap("Definition metadata", metadata);
  return Object.freeze({ ...metadata });
}

function assertEntityOptions(
  kind: string,
  name: string,
  options: EntityOptions | undefined,
): void {
  if (options === undefined) {
    return;
  }
  assertPlainObjectMap(`${kind} "${name}" options`, options);
  if (options.metadata !== undefined) {
    assertPlainObjectMap(`${kind} "${name}" metadata`, options.metadata);
  }
}

function assertDefinitionName(kind: string, name: unknown): asserts name is string {
  if (typeof name !== "string" || name.trim() === "") {
    throw new Error(`${kind} name must be a non-empty string`);
  }
}

function assertDefinitionBody(
  kind: string,
  name: string,
  value: unknown,
): asserts value is Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !isPlainObjectMap(value)
  ) {
    throw new Error(`${kind} "${name}" fields/components must be an object (plain object map)`);
  }
}

function idOrStableHash(
  kind: string,
  name: string,
  id: number | undefined,
  hashInput: string,
): number {
  if (id === undefined) {
    return stableHash32(hashInput);
  }
  if (!Number.isInteger(id) || id < 0 || id > 0xffffffff) {
    throw new RangeError(`${kind} "${name}" id must be an integer in [0, 4294967295]`);
  }
  return id;
}

function createSchemaCodec<TFields extends FieldDefinitions>(
  fieldList: readonly InternalSchemaField<unknown>[],
): SchemaCodec<TFields> {
  return {
    writeFull(writer, instance) {
      writeByMask(writer, instance, fieldList, 0xffffffff);
    },
    writeDelta(writer, instance, fieldMask) {
      writeByMask(writer, instance, fieldList, fieldMask);
    },
    readFull(reader, instance) {
      readByMask(reader, instance, fieldList, 0xffffffff);
    },
    readDelta(reader, instance, fieldMask) {
      readByMask(reader, instance, fieldList, fieldMask);
    },
  };
}

function writeByMask(
  writer: Parameters<SchemaCodec["writeFull"]>[0],
  instance: SchemaInstanceLike,
  fieldList: readonly InternalSchemaField<unknown>[],
  fieldMask: number,
): void {
  for (const field of fieldList) {
    if ((fieldMask & field.dirtyBit) === 0) {
      continue;
    }

    const ref = instance[field.fieldName];
    if (ref === undefined) {
      throw new Error(`Schema instance is missing field "${field.fieldName}"`);
    }

    field.codec.write(writer, ref.peek());
  }
}

function readByMask(
  reader: Parameters<SchemaCodec["readFull"]>[0],
  instance: SchemaInstanceLike,
  fieldList: readonly InternalSchemaField<unknown>[],
  fieldMask: number,
): void {
  for (const field of fieldList) {
    if ((fieldMask & field.dirtyBit) === 0) {
      continue;
    }

    const ref = instance[field.fieldName];
    if (ref?.setFromRemote === undefined) {
      throw new Error(`Schema instance is missing remote setter for field "${field.fieldName}"`);
    }

    ref.setFromRemote(field.codec.read(reader));
  }
}

export function getSchemaById(schemaId: number): ComponentSchema | undefined {
  return schemasById.get(schemaId);
}

export function codecForSchema<TFields extends FieldDefinitions>(
  schema: ComponentSchema<TFields>,
): SchemaCodec<TFields> {
  return (schema as InternalEntitySchema<TFields>).codec;
}

export function fieldsForSchema<TFields extends FieldDefinitions>(
  schema: ComponentSchema<TFields>,
): readonly InternalSchemaField<FieldValue<TFields[keyof TFields]>>[] {
  return (schema as InternalEntitySchema<TFields>).fieldList;
}
