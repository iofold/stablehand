interface StablehandCliBunFile extends Blob {
  exists(): Promise<boolean>;
  text(): Promise<string>;
}

declare const Bun: {
  argv: string[];
  file(path: string): StablehandCliBunFile;
  stdin: {
    stream(): ReadableStream<Uint8Array>;
  };
};
