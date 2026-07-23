import { SandboxSecretsSchema } from '@ctxmill/contracts';

/**
 * Ephemeral credentials and environment values scoped to one admitted turn.
 *
 * Turn secrets cross the sandbox boundary only on DeliverTurn. The
 * orchestrator may retain an authenticated encrypted envelope while the turn
 * is open so queued restart and HITL continuation can redeliver the exact
 * credentials. They are never attached to an AgentDefinition, container
 * bootstrap, sandbox record, or checkpoint.
 */
export type TurnSecrets = Readonly<Record<string, string>>;

export function validateTurnSecrets(secrets: TurnSecrets): void {
  const parsed = SandboxSecretsSchema.safeParse(secrets);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(
      `Invalid turn secrets${issue?.path.length ? `.${issue.path.join('.')}` : ''}: `
      + (issue?.message ?? 'validation failed'),
    );
  }
}
