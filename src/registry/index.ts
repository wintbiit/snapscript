import type { RpcDefinition } from "../rpc/index";
import type { ComponentSchema, EntitySchema } from "../schema/index";

export class Registry {
  readonly #schemasById = new Map<number, ComponentSchema>();
  readonly #schemasByName = new Map<string, ComponentSchema>();
  readonly #rpcsById = new Map<number, RpcDefinition>();
  readonly #rpcsByName = new Map<string, RpcDefinition>();

  registerEntity(schema: EntitySchema): this {
    return this.registerComponent(schema);
  }

  registerComponent(schema: ComponentSchema): this {
    const existingById = this.#schemasById.get(schema.schemaId);
    if (existingById !== undefined && existingById !== schema) {
      throw new Error(`Duplicate schema id ${schema.schemaId}: ${existingById.name} and ${schema.name}`);
    }

    const existingByName = this.#schemasByName.get(schema.name);
    if (existingByName !== undefined && existingByName !== schema) {
      throw new Error(`Duplicate schema name "${schema.name}"`);
    }

    this.#schemasById.set(schema.schemaId, schema);
    this.#schemasByName.set(schema.name, schema);
    return this;
  }

  registerRpc(rpc: RpcDefinition): this {
    const existingById = this.#rpcsById.get(rpc.rpcId);
    if (existingById !== undefined && existingById !== rpc) {
      throw new Error(`Duplicate rpc id ${rpc.rpcId}: ${existingById.name} and ${rpc.name}`);
    }

    const existingByName = this.#rpcsByName.get(rpc.name);
    if (existingByName !== undefined && existingByName !== rpc) {
      throw new Error(`Duplicate rpc name "${rpc.name}"`);
    }

    this.#rpcsById.set(rpc.rpcId, rpc);
    this.#rpcsByName.set(rpc.name, rpc);
    return this;
  }

  getSchema(schemaId: number): ComponentSchema | undefined {
    return this.#schemasById.get(schemaId);
  }

  getRpc(rpcId: number): RpcDefinition | undefined {
    return this.#rpcsById.get(rpcId);
  }
}

export function createRegistry(): Registry {
  return new Registry();
}

export type RegistryLike = Pick<Registry, "getSchema" | "getRpc">;
