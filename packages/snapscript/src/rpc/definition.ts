import { codecForField } from "../schema/fields";
import { isFieldDefinition } from "../schema/index";
import type {
  FieldDefinitions,
  FieldValue,
  FieldValues,
  InternalSchemaField,
  SchemaField,
} from "../schema/index";
import { stableHash32 } from "../utils/hash";
import { assertPlainObjectMap, isPlainObjectMap } from "../utils/object";
import type {
  CommandDefinition,
  EventDefinition,
  InternalRpcDefinition,
  RpcCodec,
  RpcDefinition,
  RpcKind,
  RpcOptions,
} from "./types";

/** Defines a client-to-server RPC command. Commands are sent with `clientWorld.send()` and handled by `serverWorld.on()`. */
export function defineCommand<TFields extends FieldDefinitions>(
  name: string,
  fields: TFields,
  options?: RpcOptions,
): CommandDefinition<TFields> {
  return defineRpc("command", name, fields, options) as CommandDefinition<TFields>;
}

/** Defines a server-to-client RPC event. Events are sent with `serverWorld.broadcast()` and handled by `clientWorld.on()`. */
export function defineEvent<TFields extends FieldDefinitions>(
  name: string,
  fields: TFields,
  options?: RpcOptions,
): EventDefinition<TFields> {
  return defineRpc("event", name, fields, options) as EventDefinition<TFields>;
}

function defineRpc<TFields extends FieldDefinitions>(
  kind: RpcKind,
  name: string,
  fields: TFields,
  options?: RpcOptions,
): RpcDefinition<TFields> {
  assertRpcName(name);
  assertRpcFields(name, fields);
  assertRpcOptions(name, options);
  const entries = Object.entries(fields);
  if (entries.length > 32) {
    throw new RangeError(`RPC "${name}" declares ${entries.length} fields; v0 supports at most 32`);
  }

  const rpcId = idOrStableHash(kind, name, options?.id);
  const channel = options?.channel ?? "reliable";
  if (channel !== "reliable" && channel !== "unreliable") {
    throw new Error(`RPC "${name}" channel must be "reliable" or "unreliable"`);
  }

  const rpcFields: Record<string, InternalSchemaField<unknown>> = {};
  const fieldList: InternalSchemaField<unknown>[] = [];

  const seenFieldIds = new Set<number>();
  entries.forEach(([fieldName, definition], index) => {
    if (!isFieldDefinition(definition)) {
      throw new Error(`RPC "${name}" field "${fieldName}" must be created by a SnapScript field helper`);
    }
    const fieldId = options?.fieldIds?.[fieldName] ?? index;
    assertRpcFieldId(name, fieldName, fieldId);
    if (seenFieldIds.has(fieldId)) {
      throw new Error(`RPC "${name}" field id ${fieldId} is used more than once`);
    }
    seenFieldIds.add(fieldId);
    const field = Object.freeze(
      definition.metadata === undefined
        ? {
            fieldId,
            fieldName,
            dirtyBit: 1 << fieldId,
            codec: codecForField(definition),
            defaultValue: definition.defaultValue,
          }
        : {
            fieldId,
            fieldName,
            dirtyBit: 1 << fieldId,
            codec: codecForField(definition),
            defaultValue: definition.defaultValue,
            metadata: definition.metadata,
          },
    );
    rpcFields[fieldName] = field;
    fieldList.push(field);
  });

  const frozenFields = Object.freeze(rpcFields) as InternalRpcDefinition<TFields>["fields"];
  const frozenFieldList = Object.freeze(fieldList) as InternalRpcDefinition<TFields>["fieldList"];
  const codec = Object.freeze(createRpcCodec<TFields>(frozenFieldList as readonly InternalSchemaField<unknown>[]));
  const base: InternalRpcDefinition<TFields> = {
    name,
    rpcId,
    kind,
    fields: frozenFields,
    fieldList: frozenFieldList,
    codec,
    channel,
  };

  return Object.freeze(
    options?.metadata === undefined
      ? base
      : { ...base, metadata: freezeMetadata(options.metadata) },
  );
}

function freezeMetadata(metadata: Record<string, unknown>): Readonly<Record<string, unknown>> {
  assertPlainObjectMap(`RPC metadata`, metadata);
  return Object.freeze({ ...metadata });
}

function assertRpcOptions(name: string, options: RpcOptions | undefined): void {
  if (options === undefined) {
    return;
  }
  assertPlainObjectMap(`RPC "${name}" options`, options);
  if (options.fieldIds !== undefined) {
    assertPlainObjectMap(`RPC "${name}" fieldIds`, options.fieldIds);
  }
  if (options.metadata !== undefined) {
    assertPlainObjectMap(`RPC "${name}" metadata`, options.metadata);
  }
}

function assertRpcFieldId(name: string, fieldName: string, fieldId: number): void {
  if (!Number.isInteger(fieldId) || fieldId < 0 || fieldId > 31) {
    throw new RangeError(`RPC "${name}" field "${fieldName}" id must be an integer in [0, 31]`);
  }
}

function assertRpcName(name: unknown): asserts name is string {
  if (typeof name !== "string" || name.trim() === "") {
    throw new Error("RPC name must be a non-empty string");
  }
}

function assertRpcFields(name: string, value: unknown): asserts value is Record<string, unknown> {
  if (!isPlainObjectMap(value)) {
    throw new Error(`RPC "${name}" fields must be an object (plain object map)`);
  }
}

function idOrStableHash(kind: RpcKind, name: string, id: number | undefined): number {
  if (id === undefined) {
    return stableHash32(`${kind}:${name}`);
  }
  if (!Number.isInteger(id) || id < 0 || id > 0xffffffff) {
    throw new RangeError(`RPC "${name}" id must be an integer in [0, 4294967295]`);
  }
  return id;
}

function createRpcCodec<TFields extends FieldDefinitions>(
  fieldList: readonly InternalSchemaField<unknown>[],
): RpcCodec<TFields> {
  const fieldNames = new Set(fieldList.map((field) => field.fieldName));

  return {
    write(writer, payload) {
      const maybePayload = payload === undefined ? {} : payload;
      if (
        maybePayload === null ||
        typeof maybePayload !== "object" ||
        Array.isArray(maybePayload) ||
        !isPlainObjectMap(maybePayload)
      ) {
        throw new Error("RPC payload must be an object (plain object map)");
      }
      const source = maybePayload as Partial<FieldValues<TFields>>;
      for (const key of Object.keys(source)) {
        if (!fieldNames.has(key)) {
          throw new Error(`RPC payload has unknown field "${key}"`);
        }
      }
      for (const field of fieldList) {
        const value = Object.hasOwn(source, field.fieldName)
          ? source[field.fieldName as keyof FieldValues<TFields>]
          : field.defaultValue;
        field.codec.write(writer, value);
      }
    },
    read(reader) {
      const payload: Record<string, unknown> = {};
      for (const field of fieldList) {
        payload[field.fieldName] = field.codec.read(reader);
      }
      return payload as FieldValues<TFields>;
    },
  };
}
