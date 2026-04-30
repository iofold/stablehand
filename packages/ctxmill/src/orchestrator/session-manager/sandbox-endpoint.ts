import type { ContainerInfo } from '../../sandbox/container-manager.js';

const GRPC_PORT = 50051;

export function sandboxGrpcBaseUrl(container: Pick<ContainerInfo, 'containerName' | 'networkIp'>): string {
  return `http://${container.networkIp ?? container.containerName}:${GRPC_PORT}`;
}
