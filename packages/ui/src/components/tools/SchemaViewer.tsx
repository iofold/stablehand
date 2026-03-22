import { cn } from '@/lib/utils';

interface SchemaViewerProps {
  schema: Record<string, unknown> | null | undefined;
  className?: string;
}

interface ParsedProperty {
  name: string;
  type: string;
  description?: string;
  required: boolean;
  depth: number;
}

function parseSchemaProperties(
  schema: Record<string, unknown>,
  requiredList: string[] = [],
  depth = 0,
  prefix = ''
): ParsedProperty[] {
  const properties = schema.properties as Record<string, any> | undefined;
  if (!properties || typeof properties !== 'object') {
    return [];
  }

  let result: ParsedProperty[] = [];

  for (const [key, value] of Object.entries(properties)) {
    if (!value || typeof value !== 'object') continue;

    const isRequired = requiredList.includes(key);
    const propName = prefix ? `${prefix}.${key}` : key;
    
    let typeStr = value.type || 'any';
    if (value.type === 'array' && value.items?.type) {
      typeStr = `array<${value.items.type}>`;
    }

    result.push({
      name: propName,
      type: typeStr,
      description: value.description,
      required: isRequired,
      depth,
    });

    if (value.type === 'object' && value.properties && depth === 0) {
      const nestedRequired = Array.isArray(value.required) ? value.required : [];
      const nestedProps = parseSchemaProperties(value, nestedRequired, depth + 1, propName);
      result = result.concat(nestedProps);
    }
  }

  return result;
}

export function SchemaViewer({ schema, className }: SchemaViewerProps) {
  if (!schema || Object.keys(schema).length === 0) {
    return (
      <div className={cn("text-xs text-surface-400 italic", className)}>
        No schema defined
      </div>
    );
  }

  const requiredList = Array.isArray(schema.required) ? schema.required : [];
  const parsedProps = parseSchemaProperties(schema, requiredList);

  if (parsedProps.length === 0) {
    return (
      <div className={cn("rounded-md border border-surface-700 bg-surface-900/50 p-3", className)}>
        <pre className="text-[11px] text-surface-300 font-mono overflow-x-auto">
          {JSON.stringify(schema, null, 2)}
        </pre>
      </div>
    );
  }

  return (
    <div className={cn("rounded-md border border-surface-700 overflow-hidden", className)}>
      <table className="w-full text-left text-xs">
        <thead className="bg-surface-800/50 border-b border-surface-700 text-surface-400">
          <tr>
            <th className="px-3 py-2 font-medium">Property</th>
            <th className="px-3 py-2 font-medium">Type</th>
            <th className="px-3 py-2 font-medium">Description</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-surface-700/50 bg-surface-900/30">
          {parsedProps.map((prop) => (
            <tr key={prop.name} className="hover:bg-surface-800/30 transition-colors">
              <td className="px-3 py-2 align-top">
                <div 
                  className="flex items-center gap-2" 
                  style={{ paddingLeft: `${prop.depth * 12}px` }}
                >
                  <span className="font-mono text-surface-200">{prop.name.split('.').pop()}</span>
                  {prop.required && (
                    <span className="inline-flex items-center rounded border border-red-500/20 bg-red-500/10 px-1 py-0.5 text-[9px] font-medium text-red-400 uppercase tracking-wider">
                      Req
                    </span>
                  )}
                </div>
              </td>
              <td className="px-3 py-2 align-top">
                <span className="font-mono text-accent-400/80">{prop.type}</span>
              </td>
              <td className="px-3 py-2 align-top text-surface-400">
                {prop.description || <span className="italic opacity-50">No description</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
