export interface StatusCodeError extends Error {
  statusCode: number;
}

export function isStatusCodeError(error: unknown): error is StatusCodeError {
  return typeof error === 'object'
    && error !== null
    && 'statusCode' in error
    && typeof (error as { statusCode?: unknown }).statusCode === 'number';
}

export function hasStatusCode(error: unknown, statusCode: number): boolean {
  return isStatusCodeError(error) && error.statusCode === statusCode;
}

export function statusCodeError(statusCode: number, message: string): StatusCodeError {
  return Object.assign(new Error(message), { statusCode });
}
