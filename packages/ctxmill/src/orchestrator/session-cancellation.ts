export const SESSION_CANCELLED_MESSAGE = 'Session cancelled';

export function isSessionCancelled(error: string | null | undefined): boolean {
  return error === SESSION_CANCELLED_MESSAGE;
}
