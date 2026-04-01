declare module 'dockerode' {
  interface FilesystemChange {
    Path: string;
    Kind: 0 | 1 | 2;
  }

  interface ContainerInfo {
    Id: string;
    Names: string[];
    State: string;
    Labels: Record<string, string>;
    NetworkSettings?: { Networks?: Record<string, { IPAddress?: string; [key: string]: unknown }> };
    [key: string]: unknown;
  }

  interface ContainerInspectInfo {
    State: { Status: string; ExitCode: number; Running: boolean };
    [key: string]: unknown;
  }

  interface ExecInspectInfo {
    ExitCode: number | null;
    [key: string]: unknown;
  }

  interface Exec {
    start(opts?: Record<string, unknown>): Promise<NodeJS.ReadWriteStream>;
    inspect(): Promise<ExecInspectInfo>;
  }

  interface Container {
    id: string;
    start(): Promise<void>;
    stop(opts?: { t?: number }): Promise<void>;
    remove(opts?: { force?: boolean; v?: boolean }): Promise<void>;
    kill(opts?: { signal?: string }): Promise<void>;
    pause(): Promise<void>;
    unpause(): Promise<void>;
    inspect(): Promise<ContainerInspectInfo>;
    logs(opts?: Record<string, unknown>): Promise<NodeJS.ReadableStream>;
    putArchive(stream: NodeJS.ReadableStream | Buffer, opts: { path: string }): Promise<void>;
    getArchive(opts: { path: string }): Promise<NodeJS.ReadableStream>;
    changes(): Promise<FilesystemChange[]>;
    exec(opts: Record<string, unknown>): Promise<Exec>;
    wait(): Promise<{ StatusCode: number }>;
  }

  interface Modem {
    demuxStream(
      stream: NodeJS.ReadableStream,
      stdout: NodeJS.WritableStream,
      stderr: NodeJS.WritableStream,
    ): void;
  }

  interface NetworkInfo {
    Id: string;
    Name: string;
    [key: string]: unknown;
  }

  interface Network {
    id: string;
    inspect(): Promise<NetworkInfo>;
    remove(): Promise<void>;
  }

  class Dockerode {
    constructor(opts?: Record<string, unknown>);
    createContainer(opts: Record<string, unknown>): Promise<Container>;
    getContainer(id: string): Container;
    listContainers(opts?: Record<string, unknown>): Promise<ContainerInfo[]>;
    getNetwork(id: string): Network;
    listNetworks(opts?: Record<string, unknown>): Promise<NetworkInfo[]>;
    createNetwork(opts: Record<string, unknown>): Promise<Network>;
    ping(): Promise<string>;
    modem: Modem;
  }

  namespace Dockerode {
    export { ContainerInfo, Container, ContainerInspectInfo, Exec, ExecInspectInfo, FilesystemChange, Modem, NetworkInfo, Network };
  }

  export = Dockerode;
}

declare module 'tar-stream' {
  import type { Readable, Transform } from 'stream';

  interface PackEntry {
    name: string;
    size?: number;
    type?: string;
    [key: string]: unknown;
  }

  interface Pack extends Transform {
    entry(header: PackEntry, data?: string | Buffer): Transform;
    entry(header: PackEntry, cb?: (err: Error | null) => void): Transform;
    finalize(): void;
  }

  interface Extract extends Transform {
    on(event: 'entry', cb: (header: PackEntry, stream: Readable, next: () => void) => void): Extract;
    on(event: string, cb: (...args: unknown[]) => void): Extract;
  }

  function pack(): Pack;
  function extract(): Extract;
}
