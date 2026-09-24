import type { z } from 'zod';

/**
 * Converts a Zod schema to a JSON Schema object suitable for the Anthropic API.
 * Handles the most common Zod types used in tool definitions.
 */
export function zodToJsonSchema(schema: z.ZodType): Record<string, unknown> {
  return convertSchema(schema);
}

function convertSchema(schema: z.ZodType): Record<string, unknown> {
  const def = (schema as any)._def;
  const typeName: string | undefined = def?.typeName;

  switch (typeName) {
    case 'ZodObject': {
      const shape = def.shape();
      const properties: Record<string, unknown> = {};
      const required: string[] = [];

      for (const [key, value] of Object.entries(shape)) {
        properties[key] = convertSchema(value as z.ZodType);
        // Check if the field is not optional
        if (!isOptional(value as z.ZodType)) {
          required.push(key);
        }
      }

      const result: Record<string, unknown> = {
        type: 'object',
        properties,
      };
      if (required.length > 0) {
        result.required = required;
      }
      return result;
    }

    case 'ZodString': {
      const result: Record<string, unknown> = { type: 'string' };
      if (def.description) result.description = def.description;
      return result;
    }

    case 'ZodNumber': {
      const result: Record<string, unknown> = { type: 'number' };
      if (def.description) result.description = def.description;
      return result;
    }

    case 'ZodBoolean': {
      const result: Record<string, unknown> = { type: 'boolean' };
      if (def.description) result.description = def.description;
      return result;
    }

    case 'ZodArray': {
      return {
        type: 'array',
        items: convertSchema(def.type),
      };
    }

    case 'ZodEnum': {
      return {
        type: 'string',
        enum: def.values,
      };
    }

    case 'ZodOptional':
      return convertSchema(def.innerType);

    case 'ZodDefault':
      return convertSchema(def.innerType);

    case 'ZodNullable': {
      const inner = convertSchema(def.innerType);
      return { ...inner, nullable: true };
    }

    case 'ZodLiteral':
      return { type: typeof def.value, const: def.value };

    case 'ZodUnion': {
      const options = (def.options as z.ZodType[]).map(convertSchema);
      return { anyOf: options };
    }

    case 'ZodRecord':
      return {
        type: 'object',
        additionalProperties: convertSchema(def.valueType),
      };

    case 'ZodEffects':
      return convertSchema(def.schema);

    case 'ZodDescription': {
      const inner = convertSchema(def.innerType);
      inner.description = def.description;
      return inner;
    }

    default:
      // Fallback for unknown types
      return { type: 'object' };
  }
}

function isOptional(schema: z.ZodType): boolean {
  const typeName = (schema as any)._def?.typeName;
  if (typeName === 'ZodOptional') return true;
  if (typeName === 'ZodDefault') return true;
  return false;
}
