import { create } from 'zustand';
import type { ApiInterruptPayload } from '@stablehand/shared';

type InterruptPayload = ApiInterruptPayload;

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
