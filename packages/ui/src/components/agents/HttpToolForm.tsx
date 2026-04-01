import { useState, useEffect } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface HttpToolDefinition {
  name: string;
  description: string;
  endpoint: string;
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  headers?: Record<string, string>;
  authentication?: {
    type: 'none' | 'bearer' | 'api-key';
    token?: string;
    apiKey?: string;
  };
  inputSchema?: Record<string, unknown>;
  timeout?: number;
}

interface HttpToolFormProps {
  tool?: HttpToolDefinition;
  onSave: (tool: HttpToolDefinition) => void;
  onCancel: () => void;
}

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'] as const;
type HttpMethod = typeof HTTP_METHODS[number];

interface HeaderRow {
  id: string;
  key: string;
  value: string;
}

function createHeaderRow(key = '', value = ''): HeaderRow {
  return {
    id: `${key}-${value}-${Math.random().toString(36).slice(2, 10)}`,
    key,
    value,
  };
}

export function HttpToolForm({ tool, onSave, onCancel }: HttpToolFormProps) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [endpoint, setEndpoint] = useState('');
  const [method, setMethod] = useState<HttpMethod>('POST');
  const [authType, setAuthType] = useState<'none' | 'bearer' | 'api-key'>('none');
  const [authToken, setAuthToken] = useState('');
  const [apiKeyName, setApiKeyName] = useState('Authorization');
  const [apiKeyValue, setApiKeyValue] = useState('');
  const [headers, setHeaders] = useState<HeaderRow[]>([]);
  const [inputSchemaText, setInputSchemaText] = useState('');
  const [timeoutStr, setTimeoutStr] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    if (tool) {
      setName(tool.name);
      setDescription(tool.description);
      setEndpoint(tool.endpoint);
      setMethod(tool.method || 'POST');
      
      if (tool.authentication) {
        setAuthType(tool.authentication.type);
        if (tool.authentication.type === 'bearer') {
          setAuthToken(tool.authentication.token || '');
        } else if (tool.authentication.type === 'api-key') {
          setApiKeyValue(tool.authentication.apiKey || '');
        }
      }
      
      if (tool.headers) {
        setHeaders(Object.entries(tool.headers).map(([key, value]) => createHeaderRow(key, value)));
      }
      
      if (tool.inputSchema) {
        setInputSchemaText(JSON.stringify(tool.inputSchema, null, 2));
      }
      
      if (tool.timeout) {
        setTimeoutStr(tool.timeout.toString());
      }
    }
  }, [tool]);

  const validate = (): boolean => {
    const errs: Record<string, string> = {};
    
    if (!name.trim()) errs.name = 'Name is required';
    if (!description.trim()) errs.description = 'Description is required';
    
    if (!endpoint.trim()) {
      errs.endpoint = 'Endpoint is required';
    } else {
      try {
        new URL(endpoint);
      } catch {
        errs.endpoint = 'Must be a valid URL';
      }
    }

    if (authType === 'bearer' && !authToken.trim()) {
      errs.authToken = 'Token is required';
    }
    
    if (authType === 'api-key') {
      if (!apiKeyName.trim()) errs.apiKeyName = 'Header name is required';
      if (!apiKeyValue.trim()) errs.apiKeyValue = 'API key is required';
    }

    if (inputSchemaText.trim()) {
      try {
        const parsed = JSON.parse(inputSchemaText);
        if (typeof parsed !== 'object' || parsed === null) {
          errs.inputSchema = 'Schema must be a JSON object';
        }
      } catch {
        errs.inputSchema = 'Must be valid JSON';
      }
    }

    if (timeoutStr.trim()) {
      const parsed = parseInt(timeoutStr, 10);
      if (isNaN(parsed) || parsed <= 0) {
        errs.timeout = 'Must be a positive number';
      }
    }

    setErrors(errs);
    return Object.keys(errs).length === 0;
  };

  const handleSave = () => {
    if (!validate()) return;

    const payload: HttpToolDefinition = {
      name: name.trim(),
      description: description.trim(),
      endpoint: endpoint.trim(),
      method,
    };

    if (authType !== 'none') {
      payload.authentication = { type: authType };
      if (authType === 'bearer') {
        payload.authentication.token = authToken.trim();
      } else if (authType === 'api-key') {
        payload.authentication.apiKey = apiKeyValue.trim();
        if (apiKeyName.trim() !== 'Authorization') {
          if (!payload.headers) payload.headers = {};
          payload.headers[apiKeyName.trim()] = apiKeyValue.trim();
        }
      }
    }

    const validHeaders = headers.filter(h => h.key.trim() && h.value.trim());
    if (validHeaders.length > 0) {
      if (!payload.headers) payload.headers = {};
      for (const h of validHeaders) {
        payload.headers[h.key.trim()] = h.value.trim();
      }
    }

    if (inputSchemaText.trim()) {
      payload.inputSchema = JSON.parse(inputSchemaText);
    }

    if (timeoutStr.trim()) {
      payload.timeout = parseInt(timeoutStr, 10);
    }

    onSave(payload);
  };

  const addHeader = () => {
    setHeaders([...headers, createHeaderRow()]);
  };

  const removeHeader = (index: number) => {
    setHeaders(headers.filter((_, i) => i !== index));
  };

  const updateHeader = (index: number, field: 'key' | 'value', val: string) => {
    const newHeaders = [...headers];
    newHeaders[index][field] = val;
    setHeaders(newHeaders);
  };

  return (
    <div className="space-y-6">
      <div className="space-y-4 pb-5 border-b border-surface-700/50">
        <div>
          <label htmlFor="http-tool-name" className="text-label">Name</label>
          <input
            id="http-tool-name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g., get_weather"
            className={cn('input-base mt-1.5', errors.name && 'border-red-500/60')}
          />
          {errors.name && <p className="mt-1 text-xs text-red-400">{errors.name}</p>}
        </div>

        <div>
          <label htmlFor="http-tool-description" className="text-label">Description</label>
          <textarea
            id="http-tool-description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What does this tool do? When should the agent use it?"
            rows={2}
            className={cn('input-base mt-1.5 resize-none', errors.description && 'border-red-500/60')}
          />
          {errors.description && <p className="mt-1 text-xs text-red-400">{errors.description}</p>}
        </div>
      </div>

      <div className="space-y-4 pb-5 border-b border-surface-700/50">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-4">
          <div className="sm:col-span-1">
            <label htmlFor="http-tool-method" className="text-label">Method</label>
            <select
              id="http-tool-method"
              value={method}
              onChange={(e) => setMethod(e.target.value as HttpMethod)}
              className="input-base mt-1.5"
            >
              {HTTP_METHODS.map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>
          </div>
          <div className="sm:col-span-3">
            <label htmlFor="http-tool-endpoint" className="text-label">Endpoint URL</label>
            <input
              id="http-tool-endpoint"
              type="url"
              value={endpoint}
              onChange={(e) => setEndpoint(e.target.value)}
              placeholder="https://api.example.com/v1/action"
              className={cn('input-base mt-1.5 font-mono', errors.endpoint && 'border-red-500/60')}
            />
            {errors.endpoint && <p className="mt-1 text-xs text-red-400">{errors.endpoint}</p>}
          </div>
        </div>
      </div>

      <div className="space-y-4 pb-5 border-b border-surface-700/50">
        <div>
          <label htmlFor="http-tool-authentication" className="text-label">Authentication</label>
          <select
            id="http-tool-authentication"
            value={authType}
            onChange={(e) => setAuthType(e.target.value as 'none' | 'bearer' | 'api-key')}
            className="input-base mt-1.5"
          >
            <option value="none">None</option>
            <option value="bearer">Bearer Token</option>
            <option value="api-key">API Key</option>
          </select>
        </div>

        {authType === 'bearer' && (
          <div>
            <label htmlFor="http-tool-token" className="text-label">Token</label>
            <input
              id="http-tool-token"
              type="password"
              value={authToken}
              onChange={(e) => setAuthToken(e.target.value)}
              placeholder="Enter bearer token"
              className={cn('input-base mt-1.5 font-mono', errors.authToken && 'border-red-500/60')}
            />
            {errors.authToken && <p className="mt-1 text-xs text-red-400">{errors.authToken}</p>}
          </div>
        )}

        {authType === 'api-key' && (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="http-tool-api-key-name" className="text-label">Header Name</label>
              <input
                id="http-tool-api-key-name"
                type="text"
                value={apiKeyName}
                onChange={(e) => setApiKeyName(e.target.value)}
                placeholder="e.g., X-API-Key"
                className={cn('input-base mt-1.5 font-mono', errors.apiKeyName && 'border-red-500/60')}
              />
              {errors.apiKeyName && <p className="mt-1 text-xs text-red-400">{errors.apiKeyName}</p>}
            </div>
            <div>
              <label htmlFor="http-tool-api-key-value" className="text-label">API Key</label>
              <input
                id="http-tool-api-key-value"
                type="password"
                value={apiKeyValue}
                onChange={(e) => setApiKeyValue(e.target.value)}
                placeholder="Enter API key"
                className={cn('input-base mt-1.5 font-mono', errors.apiKeyValue && 'border-red-500/60')}
              />
              {errors.apiKeyValue && <p className="mt-1 text-xs text-red-400">{errors.apiKeyValue}</p>}
            </div>
          </div>
        )}
      </div>

      <div className="space-y-4 pb-5 border-b border-surface-700/50">
        <div className="flex items-center justify-between">
          <span className="text-label">Headers</span>
          <button
            type="button"
            onClick={addHeader}
            className="flex items-center gap-1 text-xs font-medium text-accent-400 hover:text-accent-300 transition-colors"
          >
            <Plus className="h-3 w-3" />
            Add Header
          </button>
        </div>
        
        {headers.length === 0 ? (
          <p className="text-xs text-surface-400 italic">No custom headers</p>
        ) : (
          <div className="space-y-2">
            {headers.map((header, index) => (
              <div key={header.id} className="flex items-center gap-2">
                <input
                  aria-label={`Header name ${index + 1}`}
                  type="text"
                  value={header.key}
                  onChange={(e) => updateHeader(index, 'key', e.target.value)}
                  placeholder="Header name"
                  className="input-base font-mono text-sm"
                />
                <input
                  aria-label={`Header value ${index + 1}`}
                  type="text"
                  value={header.value}
                  onChange={(e) => updateHeader(index, 'value', e.target.value)}
                  placeholder="Value"
                  className="input-base font-mono text-sm"
                />
                <button
                  type="button"
                  onClick={() => removeHeader(index)}
                  className="p-2 text-surface-400 hover:text-red-400 transition-colors rounded-md hover:bg-surface-800"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="space-y-4 pb-5 border-b border-surface-700/50">
        <div>
          <label htmlFor="http-tool-input-schema" className="text-label">Input Schema (JSON)</label>
          <textarea
            id="http-tool-input-schema"
            value={inputSchemaText}
            onChange={(e) => setInputSchemaText(e.target.value)}
            placeholder={'{\n  "type": "object",\n  "properties": {\n    "query": { "type": "string" }\n  }\n}'}
            rows={6}
            className={cn('input-base mt-1.5 font-mono text-sm resize-y', errors.inputSchema && 'border-red-500/60')}
          />
          {errors.inputSchema && <p className="mt-1 text-xs text-red-400">{errors.inputSchema}</p>}
        </div>
      </div>

      <div className="space-y-4">
        <div>
          <label htmlFor="http-tool-timeout" className="text-label">Timeout (seconds)</label>
          <input
            id="http-tool-timeout"
            type="number"
            value={timeoutStr}
            onChange={(e) => setTimeoutStr(e.target.value)}
            placeholder="30"
            min="1"
            className={cn('input-base mt-1.5 w-32', errors.timeout && 'border-red-500/60')}
          />
          {errors.timeout && <p className="mt-1 text-xs text-red-400">{errors.timeout}</p>}
        </div>
      </div>

      <div className="flex items-center justify-end gap-4 pt-4">
        <button
          type="button"
          onClick={onCancel}
          className="text-sm font-medium text-surface-400 hover:text-surface-200 transition-colors"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={handleSave}
          className="btn-primary"
        >
          Save Tool
        </button>
      </div>
    </div>
  );
}
