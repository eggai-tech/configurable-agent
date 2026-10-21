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

export async function writeRunRecord(
  stream: NodeJS.WritableStream,
  record: RunRecord,
): Promise<void> {
  stream.write(`${JSON.stringify(record)}\n`);
}
