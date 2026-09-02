// Minimal ambient module declaration for `archiver` 8.x, which ships
// pure ESM with no bundled types. We only use ZipArchive, which is a
// subclass of Archiver. See export-package handler in src/main/index.ts.
declare module 'archiver' {
  export class Archiver {
    pipe(dest: NodeJS.WritableStream, options?: { end?: boolean }): Archiver;
    directory(dir: string, destPath: string | false): Archiver;
    file(path: string, data: { name: string }): Archiver;
    glob(pattern: string, options: { cwd: string; dest?: string }): Archiver;
    finalize(): Promise<Archiver>;
    final(): Promise<Archiver>;
    abort(): void;
    on(event: 'progress' | 'entry' | 'end', listener: (...args: any[]) => void): this;
    on(event: 'error' | 'warning', listener: (err: Error) => void): this;
    once(event: 'close' | 'end', listener: (...args: any[]) => void): this;
    removeListener(event: string, listener: (...args: any[]) => void): this;
  }
  export class ZipArchive extends Archiver {
    constructor(options?: { zlib?: { level?: number }; forceLocalTime?: boolean; forceZip64?: boolean; store?: boolean });
  }
  export class TarArchive extends Archiver {}
  export class JsonArchive extends Archiver {}
  const _default: { create: (format: string, options?: any) => Archiver };
  export default _default;
}