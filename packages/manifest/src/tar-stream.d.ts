declare module 'tar-stream' {
  import type { Buffer } from 'node:buffer';
  import type { Transform } from 'node:stream';

  interface PackEntry {
    name: string;
    size?: number;
    type?: 'file' | 'directory';
    mode?: number;
    uid?: number;
    gid?: number;
    mtime?: Date;
  }

  interface Pack extends Transform {
    entry(
      header: PackEntry,
      data: Buffer | undefined,
      callback: (error: Error | null) => void,
    ): Transform;
    finalize(): void;
  }

  function pack(): Pack;
}
