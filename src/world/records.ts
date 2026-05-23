import type { ComponentSchema, FieldDefinitions } from "../schema/index";
import type { ComponentInstance } from "./world";

export interface ComponentRecord<TFields extends FieldDefinitions = FieldDefinitions> {
  readonly entityId: number;
  readonly schema: ComponentSchema<TFields>;
  readonly instance: ComponentInstance<TFields>;
}
