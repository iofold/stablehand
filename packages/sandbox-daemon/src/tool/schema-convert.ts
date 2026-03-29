import { z } from 'zod';

export function zodToJsonSchema(schema: z.ZodType | any): Record<string, unknown> {
  if (typeof schema?.toJSONSchema !== 'function') return {};

  const raw = schema.toJSONSchema() as Record<string, unknown>;
  delete raw.$schema;
  normalizeForOpenAI(raw);
  return raw;
}

function normalizeForOpenAI(node: Record<string, unknown>): void {
  const props = node.properties as Record<string, Record<string, unknown>> | undefined;
  if (!props) return;

  const required = (node.required ?? []) as string[];
  const allKeys = Object.keys(props);

  for (const key of allKeys) {
    const prop = props[key];
    flattenAnyOf(prop);
    if (!required.includes(key)) {
      makeNullable(prop);
    }
    if (prop.type === 'object') {
      normalizeForOpenAI(prop);
    }
    if (prop.type === 'array' && prop.items && typeof prop.items === 'object') {
      normalizeForOpenAI(prop.items as Record<string, unknown>);
    }
    if (!required.includes(key) && Array.isArray(prop.anyOf)) {
      const hasNull = (prop.anyOf as Record<string, unknown>[]).some(v => v.type === 'null');
      if (!hasNull) {
        (prop.anyOf as Record<string, unknown>[]).push({ type: 'null' });
      }
    }
  }

  node.required = allKeys;
  node.additionalProperties = false;
}

function flattenAnyOf(prop: Record<string, unknown>): void {
  const anyOf = prop.anyOf as Record<string, unknown>[] | undefined;
  if (!anyOf || anyOf.length === 0) return;

  const nonNull = anyOf.filter(v => v.type !== 'null');
  const hasNull = anyOf.some(v => v.type === 'null');

  if (nonNull.length === 1) {
    const inner = nonNull[0];
    delete prop.anyOf;
    Object.assign(prop, inner);
    if (hasNull) makeNullable(prop);
  }
}

function makeNullable(prop: Record<string, unknown>): void {
  if (!prop.type) return;
  if (Array.isArray(prop.type)) {
    if (!prop.type.includes('null')) prop.type.push('null');
  } else if (prop.type !== 'null') {
    prop.type = [prop.type, 'null'];
  }
}

export function jsonSchemaToZod(jsonSchema: Record<string, unknown>): z.ZodType {
  return convertNode(jsonSchema);
}

function convertNode(node: Record<string, unknown>): z.ZodType {
  if (Array.isArray(node.anyOf)) {
    const variants = (node.anyOf as Record<string, unknown>[]).map(convertNode);
    if (variants.length < 2) {
      return variants[0] ?? z.never();
    }
    return z.union(variants as [z.ZodType, z.ZodType, ...z.ZodType[]]);
  }

  const rawType = node.type;

  if (Array.isArray(rawType)) {
    const variants = (rawType as string[]).map((t) => convertNode({ ...node, type: t }));
    if (variants.length < 2) {
      return variants[0] ?? z.never();
    }
    return z.union(variants as [z.ZodType, z.ZodType, ...z.ZodType[]]);
  }

  const type = rawType as string | undefined;

  let schema: z.ZodType;

  switch (type) {
    case 'string':
      schema = buildString(node);
      break;
    case 'number':
      schema = buildNumber(node);
      break;
    case 'integer':
      schema = buildInteger(node);
      break;
    case 'boolean':
      schema = z.boolean();
      break;
    case 'object':
      schema = buildObject(node);
      break;
    case 'array':
      schema = buildArray(node);
      break;
    default:
      if (Array.isArray(node.enum)) {
        const values = node.enum as [string, ...string[]];
        schema = z.enum(values);
        break;
      }
      schema = z.any();
  }

  if (typeof node.description === 'string') {
    schema = schema.describe(node.description);
  }

  if ('default' in node) {
    schema = (schema as z.ZodType).default(node.default as never) as unknown as z.ZodType;
  }

  return schema;
}

function buildString(node: Record<string, unknown>): z.ZodType {
  if (Array.isArray(node.enum)) {
    const values = node.enum as [string, ...string[]];
    return z.enum(values);
  }

  let s = z.string();

  if (typeof node.minLength === 'number') {
    s = s.min(node.minLength);
  }
  if (typeof node.maxLength === 'number') {
    s = s.max(node.maxLength);
  }
  if (typeof node.pattern === 'string') {
    s = s.regex(new RegExp(node.pattern));
  }

  return s;
}

function buildNumber(node: Record<string, unknown>): z.ZodType {
  let n = z.number();

  if (typeof node.minimum === 'number') {
    n = n.min(node.minimum);
  }
  if (typeof node.maximum === 'number') {
    n = n.max(node.maximum);
  }
  if (typeof node.exclusiveMinimum === 'number') {
    n = n.gt(node.exclusiveMinimum);
  }
  if (typeof node.exclusiveMaximum === 'number') {
    n = n.lt(node.exclusiveMaximum);
  }

  return n;
}

function buildInteger(node: Record<string, unknown>): z.ZodType {
  let n = z.number().int();

  if (typeof node.minimum === 'number') {
    n = n.min(node.minimum);
  }
  if (typeof node.maximum === 'number') {
    n = n.max(node.maximum);
  }
  if (typeof node.exclusiveMinimum === 'number') {
    n = n.gt(node.exclusiveMinimum);
  }
  if (typeof node.exclusiveMaximum === 'number') {
    n = n.lt(node.exclusiveMaximum);
  }

  return n;
}

function buildObject(node: Record<string, unknown>): z.ZodType {
  const properties = (node.properties ?? {}) as Record<string, Record<string, unknown>>;
  const required = new Set((node.required ?? []) as string[]);
  const additionalProperties = node.additionalProperties;

  const shape: Record<string, z.ZodType> = {};

  for (const [key, propSchema] of Object.entries(properties)) {
    const isNullable = isNullableSchema(propSchema);
    let field = convertNode(isNullable ? stripNullFromSchema(propSchema) : propSchema);
    if (!required.has(key) && !('default' in propSchema)) {
      field = field.optional();
    } else if (required.has(key) && isNullable && !('default' in propSchema)) {
      field = field.optional();
    }
    shape[key] = field;
  }

  const obj = z.object(shape);

  if (additionalProperties !== false && additionalProperties !== undefined) {
    return obj.passthrough();
  }

  return obj;
}

function isNullableSchema(node: Record<string, unknown>): boolean {
  if (Array.isArray(node.type)) {
    return (node.type as string[]).includes('null');
  }
  if (Array.isArray(node.anyOf)) {
    return (node.anyOf as Record<string, unknown>[]).some(v => v.type === 'null');
  }
  return false;
}

function stripNullFromSchema(node: Record<string, unknown>): Record<string, unknown> {
  if (Array.isArray(node.type)) {
    const types = (node.type as string[]).filter(t => t !== 'null');
    return { ...node, type: types.length === 1 ? types[0] : types };
  }
  if (Array.isArray(node.anyOf)) {
    const variants = (node.anyOf as Record<string, unknown>[]).filter(v => v.type !== 'null');
    if (variants.length === 1) {
      const { anyOf: _, ...rest } = node;
      return { ...rest, ...variants[0] };
    }
    return { ...node, anyOf: variants };
  }
  return node;
}

function buildArray(node: Record<string, unknown>): z.ZodType {
  const items = node.items as Record<string, unknown> | undefined;
  const itemSchema = items ? convertNode(items) : z.any();
  let arr = z.array(itemSchema);

  if (typeof node.minItems === 'number') {
    arr = arr.min(node.minItems);
  }
  if (typeof node.maxItems === 'number') {
    arr = arr.max(node.maxItems);
  }

  return arr;
}
