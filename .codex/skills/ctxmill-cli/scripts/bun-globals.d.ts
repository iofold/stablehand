interface CtxmillCliBunFile extends Blob {
  exists(): Promise<boolean>;
  text(): Promise<string>;
}

declare const Bun: {
  argv: string[];
  file(path: string): CtxmillCliBunFile;
  stdin: {
    stream(): ReadableStream<Uint8Array>;
  };
};
