import { BitReader, BitWriter } from "../binary/index";
import type { RegistryLike } from "../registry/index";
import type { FieldDefinitions, FieldValues } from "../schema/index";
import { MessageType } from "../sync/message";
import { codecForRpc, type RpcDefinition } from "./types";

export interface DecodedRpc<TFields extends FieldDefinitions = FieldDefinitions> {
  readonly tick: number;
  readonly sourceId: number;
  readonly targetId: number;
  readonly rpc: RpcDefinition<TFields>;
  readonly payload: FieldValues<TFields>;
}

export function encodeRpc<TFields extends FieldDefinitions>(
  rpc: RpcDefinition<TFields>,
  payload: Partial<FieldValues<TFields>> | undefined,
  tick: number,
  sourceId = 0,
  targetId = 0,
): Uint8Array {
  const writer = new BitWriter();
  writer.writeU8(MessageType.Rpc);
  writer.writeU32(tick);
  writer.writeVarU32(rpc.rpcId);
  writer.writeVarU32(sourceId);
  writer.writeVarU32(targetId);
  codecForRpc(rpc).write(writer, payload);
  return writer.finish();
}

export function decodeRpc(bytes: Uint8Array, registry: RegistryLike): DecodedRpc {
  const reader = new BitReader(bytes);
  const messageType = reader.readU8();
  if (messageType !== MessageType.Rpc) {
    throw new Error(`Unknown rpc message type ${messageType}`);
  }

  const tick = reader.readU32();
  const rpcId = reader.readVarU32();
  const sourceId = reader.readVarU32();
  const targetId = reader.readVarU32();
  const rpc = registry.getRpc(rpcId);
  if (rpc === undefined) {
    throw new Error(`Unknown rpcId ${rpcId}`);
  }

  return {
    tick,
    sourceId,
    targetId,
    rpc,
    payload: codecForRpc(rpc).read(reader),
  };
}
