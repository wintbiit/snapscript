import { BitReader, BitWriter } from "../binary/index";
import type { RegistryLike } from "../registry/index";
import type { FieldDefinitions, FieldValues } from "../schema/index";
import { MessageType } from "../sync/message";
import { codecForRpc, type StreamDefinition } from "./types";

export interface CommandStreamSampleInput<TFields extends FieldDefinitions = FieldDefinitions> {
  readonly sequence: number;
  readonly clientTick: number;
  readonly dtMs: number;
  readonly payload: Partial<FieldValues<TFields>>;
}

export interface DecodedCommandStreamSample<TFields extends FieldDefinitions = FieldDefinitions> {
  readonly sequence: number;
  readonly clientTick: number;
  readonly dtMs: number;
  readonly payload: FieldValues<TFields>;
}

export interface DecodedCommandStream<TFields extends FieldDefinitions = FieldDefinitions> {
  readonly tick: number;
  readonly sourceId: number;
  readonly targetId: number;
  readonly stream: StreamDefinition<TFields>;
  readonly samples: readonly DecodedCommandStreamSample<TFields>[];
}

export interface DecodedCommandStreamAck {
  readonly tick: number;
  readonly streamId: number;
  readonly targetId: number;
  readonly lastProcessedSequence: number;
}

export function encodeCommandStream<TFields extends FieldDefinitions>(
  stream: StreamDefinition<TFields>,
  sourceId: number,
  targetId: number,
  samples: readonly CommandStreamSampleInput<TFields>[],
  tick: number,
): Uint8Array {
  if (samples.length === 0) {
    throw new Error("Command stream packet requires at least one sample");
  }
  if (samples.length > 255) {
    throw new RangeError("Command stream packet supports at most 255 samples");
  }
  const writer = new BitWriter();
  writer.writeU8(MessageType.CommandStream);
  writer.writeU32(tick);
  writer.writeVarU32(stream.rpcId);
  writer.writeVarU32(sourceId);
  writer.writeVarU32(targetId);
  writer.writeU8(samples.length);
  let previousSequence = 0;
  let previousClientTick = 0;
  for (const sample of samples) {
    assertStreamNumber(sample.sequence, "sequence");
    assertStreamNumber(sample.clientTick, "clientTick");
    assertStreamNumber(sample.dtMs, "dtMs");
    if (sample.sequence < previousSequence) {
      throw new Error("Command stream samples must be sorted by sequence");
    }
    writer.writeVarU32(sample.sequence - previousSequence);
    writer.writeVarU32(sample.clientTick - previousClientTick);
    writer.writeVarU32(sample.dtMs);
    codecForRpc(stream).write(writer, sample.payload);
    previousSequence = sample.sequence;
    previousClientTick = sample.clientTick;
  }
  return writer.finish();
}

export function decodeCommandStream(bytes: Uint8Array, registry: RegistryLike): DecodedCommandStream {
  const reader = new BitReader(bytes);
  const messageType = reader.readU8();
  if (messageType !== MessageType.CommandStream) {
    throw new Error(`Unknown command stream message type ${messageType}`);
  }
  const tick = reader.readU32();
  const streamId = reader.readVarU32();
  const sourceId = reader.readVarU32();
  const targetId = reader.readVarU32();
  const stream = registry.getRpc(streamId);
  if (stream === undefined) {
    throw new Error(`Unknown streamId ${streamId}`);
  }
  if (stream.kind !== "stream") {
    throw new Error(`RPC "${stream.name}" is not a stream`);
  }
  const count = reader.readU8();
  const samples: DecodedCommandStreamSample[] = [];
  let sequence = 0;
  let clientTick = 0;
  for (let index = 0; index < count; index += 1) {
    sequence += reader.readVarU32();
    clientTick += reader.readVarU32();
    const dtMs = reader.readVarU32();
    samples.push({
      sequence,
      clientTick,
      dtMs,
      payload: codecForRpc(stream).read(reader),
    });
  }
  return {
    tick,
    sourceId,
    targetId,
    stream: stream as StreamDefinition,
    samples,
  };
}

export function encodeCommandStreamAck(
  streamId: number,
  targetId: number,
  lastProcessedSequence: number,
  tick: number,
): Uint8Array {
  assertStreamNumber(streamId, "streamId");
  assertStreamNumber(targetId, "targetId");
  assertStreamNumber(lastProcessedSequence, "lastProcessedSequence");
  const writer = new BitWriter();
  writer.writeU8(MessageType.CommandStreamAck);
  writer.writeU32(tick);
  writer.writeVarU32(streamId);
  writer.writeVarU32(targetId);
  writer.writeVarU32(lastProcessedSequence);
  return writer.finish();
}

export function decodeCommandStreamAck(bytes: Uint8Array): DecodedCommandStreamAck {
  const reader = new BitReader(bytes);
  const messageType = reader.readU8();
  if (messageType !== MessageType.CommandStreamAck) {
    throw new Error(`Unknown command stream ack message type ${messageType}`);
  }
  return {
    tick: reader.readU32(),
    streamId: reader.readVarU32(),
    targetId: reader.readVarU32(),
    lastProcessedSequence: reader.readVarU32(),
  };
}

function assertStreamNumber(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    throw new RangeError(`Command stream ${label} must be an integer in [0, 4294967295]`);
  }
}
