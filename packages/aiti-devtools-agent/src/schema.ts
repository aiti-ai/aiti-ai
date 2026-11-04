/**
 * JSON Schema（桥 TOOLS 的 inputSchema，手写对象）→ typebox TSchema（宿主 registerTool 的 parameters）。
 * 桥的 TOOLS 只用 object/string/number/boolean/array + description/required/items，转换器覆盖即可。
 * 自 packages/aiti-devtools-pi（原 examples/dbg-widget/src/pi-ext）移入（agent 层公共）。
 */
import { Type, type TSchema } from "typebox";

export function jsonSchemaToTypeBox(schema: any): TSchema {
  if (!schema || typeof schema !== "object") return Type.Object({});
  const opts = (d?: string) => (d ? { description: d } : {});
  switch (schema.type) {
    case "string":
      return Type.String(opts(schema.description));
    case "number":
      return Type.Number(opts(schema.description));
    case "integer":
      return Type.Integer(opts(schema.description));
    case "boolean":
      return Type.Boolean(opts(schema.description));
    case "array": {
      const item = schema.items ? jsonSchemaToTypeBox(schema.items) : Type.Any();
      return Type.Array(item, opts(schema.description));
    }
    case "object": {
      const props: Record<string, TSchema> = {};
      const required: string[] = Array.isArray(schema.required) ? schema.required : [];
      for (const [k, v] of Object.entries((schema.properties as Record<string, any>) || {})) {
        const t = jsonSchemaToTypeBox(v);
        props[k] = required.includes(k) ? t : Type.Optional(t);
      }
      return Type.Object(props, opts(schema.description));
    }
    default:
      // enum 或未知 → 宽松对象（参数仍会透传给工具执行，桥有容错）
      return Type.Object({}, opts(schema.description));
  }
}
