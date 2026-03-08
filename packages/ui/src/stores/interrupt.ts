import { create } from 'zustand';

interface InterruptPayload {
  agentId: string;
  toolName: string;
  args: Record<string, unknown>;
  toolCallId: string;
}

interface InterruptStore {
  pending: InterruptPayload | null;
  setPending: (interrupt: InterruptPayload | null) => void;
  clear: () => void;
}

export const useInterruptStore = create<InterruptStore>((set) => ({
  pending: null,
  setPending: (interrupt) => set({ pending: interrupt }),
  clear: () => set({ pending: null }),
}));
