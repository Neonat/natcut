import { ReadOnlyPixCut } from './protocol.mjs';

export async function readPrinterSnapshot({ openSession }) {
  const session = await openSession();
  try {
    const printer = new ReadOnlyPixCut(session.io);
    return await printer.snapshot();
  } finally {
    await session.close();
  }
}
