import type { Page, Locator } from '@playwright/test';

declare const process: {
  env: Record<string, string | undefined>;
  cwd(): string;
};

type FsModule = {
  mkdirSync(path: string, options: { recursive: boolean }): void;
  writeFileSync(path: string, data: Uint8Array | string): void;
  existsSync(path: string): boolean;
};

type PathModule = {
  join(...paths: string[]): string;
};

const loadFs = new Function('return import("node:fs")') as () => Promise<FsModule>;
const loadPath = new Function('return import("node:path")') as () => Promise<PathModule>;

export interface CaptureResult {
  eventType: string;
  filePath: string;
  description: string;
  timestamp: number;
}

export class ScreenshotCapture {
  private captures: CaptureResult[] = [];
  private counter = 0;

  constructor(
    private readonly page: Page,
    private readonly harness: string,
    private readonly mode: 'live' | 'replay' = 'live',
  ) {}

  async captureViewport(eventType: string, description: string): Promise<CaptureResult> {
    const fs = await loadFs();
    const path = await loadPath();
    const dir = path.join(
      process.cwd(), 'tests', 'e2e', 'visual-qa', 'captures',
      this.harness, this.mode,
    );
    fs.mkdirSync(dir, { recursive: true });

    const index = String(this.counter++).padStart(2, '0');
    const fileName = `${index}-${eventType}.png`;
    const filePath = path.join(dir, fileName);

    const buffer = await this.page.screenshot({ fullPage: false });
    fs.writeFileSync(filePath, buffer);

    const result: CaptureResult = {
      eventType,
      filePath,
      description,
      timestamp: Date.now(),
    };
    this.captures.push(result);
    return result;
  }

  async captureComponent(
    locator: Locator,
    eventType: string,
    description: string,
  ): Promise<CaptureResult> {
    const fs = await loadFs();
    const path = await loadPath();
    const dir = path.join(
      process.cwd(), 'tests', 'e2e', 'visual-qa', 'captures',
      this.harness, this.mode,
    );
    fs.mkdirSync(dir, { recursive: true });

    const index = String(this.counter++).padStart(2, '0');
    const fileName = `${index}-${eventType}-component.png`;
    const filePath = path.join(dir, fileName);

    const buffer = await locator.screenshot();
    fs.writeFileSync(filePath, buffer);

    const result: CaptureResult = {
      eventType,
      filePath,
      description,
      timestamp: Date.now(),
    };
    this.captures.push(result);
    return result;
  }

  getCaptures(): CaptureResult[] {
    return [...this.captures];
  }

  async writeManifest(): Promise<string> {
    const fs = await loadFs();
    const path = await loadPath();
    const dir = path.join(
      process.cwd(), 'tests', 'e2e', 'visual-qa', 'captures',
      this.harness, this.mode,
    );
    fs.mkdirSync(dir, { recursive: true });

    const manifestPath = path.join(dir, 'manifest.json');
    const manifest = {
      harness: this.harness,
      mode: this.mode,
      capturedAt: new Date().toISOString(),
      captures: this.captures.map((c) => ({
        eventType: c.eventType,
        filePath: c.filePath,
        description: c.description,
        timestamp: c.timestamp,
      })),
    };
    fs.writeFileSync(manifestPath, new TextEncoder().encode(JSON.stringify(manifest, null, 2)));
    return manifestPath;
  }
}
