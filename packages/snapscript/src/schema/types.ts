import type { BinaryReader, BinaryWriter, FieldCodec } from "../binary/index";

export const fieldDefinitionBrand: unique symbol = Symbol("SnapScriptFieldDefinition");

export interface FieldDefinition<T> {
  readonly [fieldDefinitionBrand]: true;
  readonly defaultValue: T;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface InternalFieldDefinition<T> extends FieldDefinition<T> {
  readonly codec: FieldCodec<T>;
}

export function isFieldDefinition(value: unknown): value is FieldDefinition<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { readonly [fieldDefinitionBrand]?: unknown })[fieldDefinitionBrand] === true
  );
}

export interface EntityOptions {
  readonly id?: number;
  readonly fieldIds?: Record<string, number>;
  readonly replicated?: boolean;
  readonly metadata?: Record<string, unknown>;
}

export type FieldDefinitions = Record<string, FieldDefinition<any>>;

export type FieldValue<TDefinition> =
  TDefinition extends FieldDefinition<infer TValue> ? TValue : never;

export type FieldValues<TFields extends FieldDefinitions> = {
  [K in keyof TFields]: FieldValue<TFields[K]>;
};

export interface FieldMeta<T> {
  readonly entityId: number;
  readonly schemaId: number;
  readonly schemaName: string;
  readonly fieldId: number;
  readonly fieldName: string;
  readonly dirtyBit: number;
  readonly defaultValue: T;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface InternalFieldMeta<T> extends FieldMeta<T> {
  readonly codec: FieldCodec<T>;
}

export interface SchemaField<T> {
  readonly fieldId: number;
  readonly fieldName: string;
  readonly dirtyBit: number;
  readonly defaultValue: T;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface InternalSchemaField<T> extends SchemaField<T> {
  readonly codec: FieldCodec<T>;
}

export type SchemaInstanceLike = Record<string, { peek(): unknown; setFromRemote?(value: unknown): void }>;

export interface SchemaCodec<TFields extends FieldDefinitions = FieldDefinitions> {
  writeFull(writer: BinaryWriter, instance: SchemaInstanceLike): void;
  writeDelta(writer: BinaryWriter, instance: SchemaInstanceLike, fieldMask: number): void;
  readFull(reader: BinaryReader, instance: SchemaInstanceLike): void;
  readDelta(reader: BinaryReader, instance: SchemaInstanceLike, fieldMask: number): void;
}

export interface EntitySchema<
  TFields extends FieldDefinitions = FieldDefinitions,
  TReplicated extends boolean = boolean,
> {
  readonly kind: "component";
  readonly name: string;
  readonly schemaId: number;
  readonly replicated: TReplicated;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly fields: {
    readonly [K in keyof TFields]: SchemaField<FieldValue<TFields[K]>>;
  };
  readonly fieldList: readonly SchemaField<FieldValue<TFields[keyof TFields]>>[];
  readonly fieldCount: number;
  readonly fullMask: number;
}

export interface InternalEntitySchema<
  TFields extends FieldDefinitions = FieldDefinitions,
  TReplicated extends boolean = boolean,
> extends EntitySchema<TFields, TReplicated> {
  readonly fields: {
    readonly [K in keyof TFields]: InternalSchemaField<FieldValue<TFields[K]>>;
  };
  readonly fieldList: readonly InternalSchemaField<FieldValue<TFields[keyof TFields]>>[];
  readonly codec: SchemaCodec<TFields>;
}

export type ComponentSchema<
  TFields extends FieldDefinitions = FieldDefinitions,
  TReplicated extends boolean = boolean,
> = EntitySchema<TFields, TReplicated>;

export type ComponentMap = Record<string, ComponentSchema>;

export interface PrefabDefinition<TComponents extends ComponentMap = ComponentMap> {
  readonly kind: "prefab";
  readonly name: string;
  readonly prefabId: number;
  readonly components: TComponents;
  readonly componentList: readonly TComponents[keyof TComponents][];
  readonly component?: TComponents[keyof TComponents];
  readonly metadata?: Readonly<Record<string, unknown>>;
}
