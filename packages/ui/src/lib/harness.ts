// Display labels for harness wire names. The API/config value stays the
// canonical name ('langgraph'); only presentation changes. 'deepagents' is
// named because that is the SDK the langgraph harness actually wraps.
export const HARNESS_LABELS: Record<string, string> = {
  langgraph: 'LangGraph (deepagents)',
  'claude-agents': 'Claude Agents',
  'pi-agent': 'PI Agent',
};

export function harnessLabel(name: string | null | undefined): string {
  if (!name) return '';
  return HARNESS_LABELS[name] ?? name;
}
