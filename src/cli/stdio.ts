export async function readAllStdin(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export interface RunRecord {
  ok: boolean;
  finalText: string;
  structured?: unknown;
  error: string | null;
}

// Resolves once the record is flushed to the underlying resource, so the
// process can exit without truncating stdout on a backpressured pipe.
export function writeRunRecord(stream: NodeJS.WritableStream, record: RunRecord): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.write(`${JSON.stringify(record)}\n`, (err) => (err ? reject(err) : resolve()));
  });
}
