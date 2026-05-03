import { diag, DiagConsoleLogger, DiagLogLevel, type Span } from '@opentelemetry/api';
import {
  getNodeAutoInstrumentations,
  getResourceDetectors,
  type InstrumentationConfigMap,
} from '@opentelemetry/auto-instrumentations-node';
import { NodeSDK } from '@opentelemetry/sdk-node';
import type { ClientRequest, IncomingMessage, RequestOptions, ServerResponse } from 'node:http';

const DEFAULT_ENABLED_INSTRUMENTATIONS = [
  'aws-sdk',
  'dns',
  'grpc',
  'http',
  'net',
  'openai',
  'pg',
  'pino',
  'runtime-node',
  'undici',
].join(',');

const REDACTED = '[redacted]';
const SENSITIVE_QUERY_PARAM_NAMES = new Set([
  'access_key',
  'access_token',
  'apikey',
  'api_key',
  'apikeyid',
  'authorization',
  'client_secret',
  'code',
  'env',
  'key',
  'password',
  'refresh_token',
  'secret',
  'sig',
  'signature',
  'token',
  'x-amz-credential',
  'x-amz-security-token',
  'x-amz-signature',
  'x-goog-signature',
]);

const DIAG_LOG_LEVELS: Readonly<Record<string, DiagLogLevel>> = {
  all: DiagLogLevel.ALL,
  verbose: DiagLogLevel.VERBOSE,
  debug: DiagLogLevel.DEBUG,
  info: DiagLogLevel.INFO,
  warn: DiagLogLevel.WARN,
  error: DiagLogLevel.ERROR,
  none: DiagLogLevel.NONE,
};

interface UndiciRequestLike {
  origin: string;
  path: string;
}

function configureDiagLogger(): void {
  const configuredLevel = process.env.OTEL_LOG_LEVEL?.trim().toLowerCase();
  if (!configuredLevel) {
    return;
  }

  const logLevel = DIAG_LOG_LEVELS[configuredLevel];
  if (logLevel === undefined) {
    return;
  }

  diag.setLogger(new DiagConsoleLogger(), { logLevel });
}

function configureDefaultInstrumentations(): void {
  if (!process.env.OTEL_NODE_ENABLED_INSTRUMENTATIONS) {
    process.env.OTEL_NODE_ENABLED_INSTRUMENTATIONS = DEFAULT_ENABLED_INSTRUMENTATIONS;
  }
}

function isSensitiveQueryParam(name: string): boolean {
  const normalizedName = name.trim().toLowerCase().replaceAll('-', '_');
  return SENSITIVE_QUERY_PARAM_NAMES.has(normalizedName) || normalizedName.endsWith('_token');
}

function sanitizeQueryString(rawQuery: string): string {
  const params = new URLSearchParams(rawQuery);
  for (const key of params.keys()) {
    if (isSensitiveQueryParam(key)) {
      params.set(key, REDACTED);
    }
  }
  return params.toString();
}

function sanitizePath(rawPath: string | undefined): string | undefined {
  if (!rawPath) {
    return rawPath;
  }

  const queryStart = rawPath.indexOf('?');
  if (queryStart === -1) {
    return rawPath;
  }

  const pathname = rawPath.slice(0, queryStart);
  const query = sanitizeQueryString(rawPath.slice(queryStart + 1));
  return query ? `${pathname}?${query}` : pathname;
}

function redactUrl(rawUrl: string | undefined): string | undefined {
  if (!rawUrl) {
    return rawUrl;
  }

  try {
    const parsedUrl = new URL(rawUrl);
    parsedUrl.search = sanitizeQueryString(parsedUrl.searchParams.toString());
    return parsedUrl.toString();
  } catch {
    return sanitizePath(rawUrl);
  }
}

function getPathQuery(path: string | undefined): string | undefined {
  if (!path) {
    return undefined;
  }

  const queryStart = path.indexOf('?');
  return queryStart === -1 ? undefined : REDACTED;
}

function getUrlPath(path: string | undefined): string | undefined {
  if (!path) {
    return undefined;
  }

  const queryStart = path.indexOf('?');
  return queryStart === -1 ? path : path.slice(0, queryStart);
}

function getRequestOptionsPath(options: RequestOptions): string | undefined {
  return typeof options.path === 'string' ? options.path : undefined;
}

function isDockerRequest(options: RequestOptions): boolean {
  const socketPath = typeof options.socketPath === 'string' ? options.socketPath : '';
  const path = getRequestOptionsPath(options) ?? '';
  return socketPath.includes('docker.sock')
    || path.includes('/containers/')
    || path.includes('/networks/')
    || path.includes('/containers/create');
}

function isOtlpExporterTarget(host: string | undefined, path: string | undefined): boolean {
  if (!host || !path) {
    return false;
  }

  const configuredEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!configuredEndpoint) {
    return false;
  }

  try {
    const parsedEndpoint = new URL(configuredEndpoint);
    return host === parsedEndpoint.host && (
      path.startsWith('/v1/traces')
      || path.startsWith('/v1/metrics')
      || path.startsWith('/v1/logs')
    );
  } catch {
    return false;
  }
}

function isOtlpHttpRequest(options: RequestOptions): boolean {
  const hostname = options.hostname ?? options.host;
  return isOtlpExporterTarget(hostname ? String(hostname) : undefined, getRequestOptionsPath(options));
}

function isOtlpUndiciRequest(request: UndiciRequestLike): boolean {
  try {
    const origin = new URL(request.origin);
    return isOtlpExporterTarget(origin.host, request.path);
  } catch {
    return false;
  }
}

function isClientRequest(request: ClientRequest | IncomingMessage): request is ClientRequest {
  return typeof (request as ClientRequest).getHeader === 'function';
}

function requestPath(request: ClientRequest | IncomingMessage): string | undefined {
  if (isClientRequest(request)) {
    return typeof request.path === 'string' ? request.path : undefined;
  }

  return typeof request.url === 'string' ? request.url : undefined;
}

function setSanitizedHttpAttributes(span: Span, path: string | undefined, url: string | undefined): void {
  const sanitizedPath = sanitizePath(path);
  const sanitizedUrl = redactUrl(url);
  const pathOnly = getUrlPath(sanitizedPath);
  const query = getPathQuery(sanitizedPath);

  if (sanitizedPath) {
    span.setAttribute('http.target', sanitizedPath);
  }
  if (sanitizedUrl) {
    span.setAttribute('http.url', sanitizedUrl);
    span.setAttribute('url.full', sanitizedUrl);
  }
  if (pathOnly) {
    span.setAttribute('url.path', pathOnly);
  }
  if (query) {
    span.setAttribute('url.query', query);
  }
}

function setSanitizedHttpRequestAttributes(
  span: Span,
  request: ClientRequest | IncomingMessage,
): void {
  setSanitizedHttpAttributes(span, requestPath(request), undefined);
}

function setSanitizedHttpFinalAttributes(
  span: Span,
  request: ClientRequest | IncomingMessage,
  _response: IncomingMessage | ServerResponse,
): void {
  setSanitizedHttpAttributes(span, requestPath(request), undefined);
}

function setSanitizedUndiciAttributes(span: Span, request: UndiciRequestLike): void {
  setSanitizedHttpAttributes(span, request.path, `${request.origin}${request.path}`);
}

configureDiagLogger();
configureDefaultInstrumentations();

const instrumentationConfigs: InstrumentationConfigMap = {
  '@opentelemetry/instrumentation-http': {
    ignoreOutgoingRequestHook: (options: RequestOptions) => {
      return isDockerRequest(options) || isOtlpHttpRequest(options);
    },
    requestHook: setSanitizedHttpRequestAttributes,
    applyCustomAttributesOnSpan: setSanitizedHttpFinalAttributes,
    redactedQueryParams: Array.from(SENSITIVE_QUERY_PARAM_NAMES),
    headersToSpanAttributes: {
      client: { requestHeaders: [], responseHeaders: [] },
      server: { requestHeaders: [], responseHeaders: [] },
    },
  },
  '@opentelemetry/instrumentation-openai': {
    captureMessageContent: false,
  },
  '@opentelemetry/instrumentation-undici': {
    ignoreRequestHook: isOtlpUndiciRequest,
    requestHook: setSanitizedUndiciAttributes,
    headersToSpanAttributes: {
      requestHeaders: [],
      responseHeaders: [],
    },
  },
};

const sdk = new NodeSDK({
  instrumentations: getNodeAutoInstrumentations(instrumentationConfigs),
  resourceDetectors: getResourceDetectors(),
});

try {
  sdk.start();
  diag.info('OpenTelemetry automatic instrumentation started successfully');
} catch (error) {
  diag.error(
    'Error initializing OpenTelemetry SDK. The process is not instrumented and will not produce telemetry',
    error,
  );
}

async function shutdown(): Promise<void> {
  try {
    await sdk.shutdown();
    diag.debug('OpenTelemetry SDK terminated');
  } catch (error) {
    diag.error('Error terminating OpenTelemetry SDK', error);
  }
}

process.on('SIGTERM', () => {
  void shutdown();
});

process.once('beforeExit', () => {
  void shutdown();
});
