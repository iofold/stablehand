import type { ArtifactInsert, ArtifactRow } from '../database/types.js';
import type {
  DatabaseRepository,
  ExpectedSandboxCallbackDelivery,
} from '../database/repository.js';
import type { TypedEventBus } from '../events/bus.js';

type OwnedArtifactInsert = ArtifactInsert & { agentId: string };

export interface ArtifactRegistrationServiceDeps {
  repository: Pick<
    DatabaseRepository,
    'saveArtifact' | 'saveArtifactIfDeliveryOwned'
  >;
  eventBus?: TypedEventBus;
  now?: () => number;
}

/** One persistence-and-event seam shared by REST and sandbox callbacks. */
export class ArtifactRegistrationService {
  private readonly now: () => number;

  constructor(private readonly deps: ArtifactRegistrationServiceDeps) {
    this.now = deps.now ?? Date.now;
  }

  async register(data: OwnedArtifactInsert): Promise<ArtifactRow> {
    const row = await this.deps.repository.saveArtifact(data);
    this.emitCreated(row.id, data);
    return row;
  }

  async registerIfDeliveryOwned(
    data: OwnedArtifactInsert,
    delivery: ExpectedSandboxCallbackDelivery,
  ): Promise<ArtifactRow | undefined> {
    const row = await this.deps.repository.saveArtifactIfDeliveryOwned(data, delivery);
    if (row) {
      this.emitCreated(row.id, data);
    }
    return row;
  }

  private emitCreated(artifactId: string, data: OwnedArtifactInsert): void {
    this.deps.eventBus?.emit('artifact.created', {
      artifactId,
      agentId: data.agentId,
      ...(data.turnId ? { turnId: data.turnId } : {}),
      name: data.name,
      mimeType: data.mimeType,
      sizeBytes: data.sizeBytes,
      ...(data.kind ? { kind: data.kind } : {}),
      ...(data.sha256 ? { sha256: data.sha256 } : {}),
      timestamp: this.now(),
    });
  }
}
