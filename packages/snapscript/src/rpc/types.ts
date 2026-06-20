import type { BinaryReader, BinaryWriter } from "../binary/index";
import type { ChannelName } from "../platform/index";
import type { EntityRef, ReadonlyEntityRef } from "../world/index";
import type {
  FieldDefinition,
  FieldDefinitions,
  FieldValue,
  FieldValues,
  SchemaField,
} from "../schema/index";

/** RPC direction: commands/streams travel client-to-server, events travel server-to-client. */
export type RpcKind = "command" | "event" | "stream";

/** Fully defaulted payload shape for an RPC definition. */
export type RpcPayload<TFields extends FieldDefinitions> = FieldValues<TFields>;

export interface RpcCodec<TFields extends FieldDefinitions = FieldDefinitions> {
  write(writer: BinaryWriter, payload?: Partial<FieldValues<TFields>>): void;
  read(reader: BinaryReader): FieldValues<TFields>;
}

/** Frozen command, event, or stream definition created by `defineCommand()`, `defineEvent()`, or `defineStream()`. */
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

/** Client-to-server stream definition. */
export type StreamDefinition<TFields extends FieldDefinitions = FieldDefinitions> =
  RpcDefinition<TFields> & { readonly kind: "stream"; readonly channel: "unreliable" };

export interface CommandStreamSample<TPayload = unknown> {
  readonly sequence: number;
  readonly clientTick: number;
  readonly dtMs: number;
  readonly payload: Readonly<TPayload>;
}

export interface CommandStreamCtx<TPayload = unknown> {
  readonly source: ReadonlyEntityRef;
  readonly target: EntityRef;
  readonly stream: StreamDefinition;
  readonly channel: ChannelName;
  readonly samples: readonly CommandStreamSample<TPayload>[];
}

export type CommandStreamHandler<TFields extends FieldDefinitions> = (
  context: CommandStreamCtx<FieldValues<TFields>>,
) => void;

export type CommandStreamValidator<TFields extends FieldDefinitions> = (
  context: CommandStreamCtx<FieldValues<TFields>>,
) => RpcValidationFailure | undefined;

/** Optional id/channel/metadata settings for command and event definitions. */
export interface RpcOptions {
  readonly id?: number;
  readonly fieldIds?: Record<string, number>;
  readonly channel?: ChannelName;
  readonly metadata?: Record<string, unknown>;
}

/** Handler invoked with a frozen RPC context object. */
export type RpcHandler<TFields extends FieldDefinitions> = (context: RpcCtx<FieldValues<TFields>>) => void;

/** Handler invoked with a frozen command context object. */
export type CommandHandler<TFields extends FieldDefinitions> = (context: CommandCtx<FieldValues<TFields>>) => void;

/** Handler invoked with a frozen event context object. */
export type EventHandler<TFields extends FieldDefinitions> = (context: EventCtx<FieldValues<TFields>>) => void;

export interface RpcValidationFailure {
  readonly reason: string;
  readonly details?: Record<string, unknown>;
}

export type CommandValidator<TFields extends FieldDefinitions> = (
  context: CommandCtx<FieldValues<TFields>>,
) => RpcValidationFailure | undefined;

export type EventValidator<TFields extends FieldDefinitions> = (
  context: EventCtx<FieldValues<TFields>>,
) => RpcValidationFailure | undefined;

/** Runtime context passed to command and event handlers. */
export interface RpcCtx<TPayload = unknown> {
  readonly payload: Readonly<TPayload>;
  readonly tick: number;
  readonly rpc: RpcDefinition;
  readonly channel: ChannelName;
  readonly source: ReadonlyEntityRef;
  readonly target: ReadonlyEntityRef;
}

/** Runtime context passed to client-to-server command handlers. */
export interface CommandCtx<TPayload = unknown> {
  readonly payload: Readonly<TPayload>;
  readonly tick: number;
  readonly rpc: RpcDefinition;
  readonly channel: ChannelName;
  readonly source: ReadonlyEntityRef;
  readonly target: EntityRef;
}

/** Runtime context passed to server-to-client event handlers. */
export interface EventCtx<TPayload = unknown> {
  readonly payload: Readonly<TPayload>;
  readonly tick: number;
  readonly rpc: RpcDefinition;
  readonly channel: ChannelName;
  readonly source: ReadonlyEntityRef;
  readonly target: ReadonlyEntityRef;
}

export type RpcFieldsInput = Record<string, FieldDefinition<unknown>>;

export function codecForRpc<TFields extends FieldDefinitions>(
  rpc: RpcDefinition<TFields>,
): RpcCodec<TFields> {
  return (rpc as InternalRpcDefinition<TFields>).codec;
}
