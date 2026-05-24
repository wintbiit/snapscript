import type { BinaryReader, BinaryWriter } from "../binary/index";
import type { ChannelName, PeerId } from "../platform/index";
import type {
  FieldDefinition,
  FieldDefinitions,
  FieldValue,
  FieldValues,
  SchemaField,
} from "../schema/index";

/** RPC direction: commands travel client-to-server, events travel server-to-client. */
export type RpcKind = "command" | "event";

/** Fully defaulted payload shape for an RPC definition. */
export type RpcPayload<TFields extends FieldDefinitions> = FieldValues<TFields>;

export interface RpcCodec<TFields extends FieldDefinitions = FieldDefinitions> {
  write(writer: BinaryWriter, payload?: Partial<FieldValues<TFields>>): void;
  read(reader: BinaryReader): FieldValues<TFields>;
}

/** Frozen command or event definition created by `defineCommand()` or `defineEvent()`. */
export interface RpcDefinition<TFields extends FieldDefinitions = FieldDefinitions> {
  readonly name: string;
  readonly rpcId: number;
  readonly kind: RpcKind;
  readonly fields: {
    readonly [K in keyof TFields]: SchemaField<FieldValue<TFields[K]>>;
  };
  readonly fieldList: readonly SchemaField<FieldValue<TFields[keyof TFields]>>[];
  readonly channel: ChannelName;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface InternalRpcDefinition<TFields extends FieldDefinitions = FieldDefinitions>
  extends RpcDefinition<TFields> {
  readonly codec: RpcCodec<TFields>;
}

/** Client-to-server RPC definition. */
export type CommandDefinition<TFields extends FieldDefinitions = FieldDefinitions> =
  RpcDefinition<TFields> & { readonly kind: "command" };

/** Server-to-client RPC definition. */
export type EventDefinition<TFields extends FieldDefinitions = FieldDefinitions> =
  RpcDefinition<TFields> & { readonly kind: "event" };

/** Optional id/channel/metadata settings for command and event definitions. */
export interface RpcOptions {
  readonly id?: number;
  readonly fieldIds?: Record<string, number>;
  readonly channel?: ChannelName;
  readonly metadata?: Record<string, unknown>;
}

/** Handler invoked with a frozen RPC context object. */
export type RpcHandler<TFields extends FieldDefinitions> = (context: RpcCtx<FieldValues<TFields>>) => void;

/** Runtime context passed to command and event handlers. */
export interface RpcCtx<TPayload = unknown> {
  readonly payload: Readonly<TPayload>;
  readonly tick: number;
  readonly rpc: RpcDefinition;
  readonly channel: ChannelName;
  readonly sender: PeerId;
}

export type RpcFieldsInput = Record<string, FieldDefinition<unknown>>;

export function codecForRpc<TFields extends FieldDefinitions>(
  rpc: RpcDefinition<TFields>,
): RpcCodec<TFields> {
  return (rpc as InternalRpcDefinition<TFields>).codec;
}
