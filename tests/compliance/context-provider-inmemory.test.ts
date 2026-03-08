import { contextProviderCompliance } from './context-provider.compliance.js';
import { InMemoryContextProvider } from '../../packages/ctxmill/src/knowledge/context.js';

contextProviderCompliance('InMemoryContextProvider', () => new InMemoryContextProvider());
