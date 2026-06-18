import { describe, it, expect, vi } from 'vitest';
import { SpiderPage } from '../page.js';
import type { ProtocolAdapter } from '../protocol/protocol-adapter.js';

function createPage(sendCommand: ReturnType<typeof vi.fn>): SpiderPage {
  const adapter = { sendCommand } as unknown as ProtocolAdapter;
  return new SpiderPage(adapter);
}

describe('SpiderPage session snapshots', () => {
  it('saveSnapshot sends Snapshot.capture and returns the blob', async () => {
    const sendCommand = vi
      .fn()
      .mockResolvedValue({ id: 'x', cached: true, snapshot: { url: 'about:blank' } });
    const page = createPage(sendCommand);

    const blob = await page.saveSnapshot('s1');

    expect(sendCommand).toHaveBeenCalledWith('Snapshot.capture', { id: 's1' });
    expect(blob).toEqual({ url: 'about:blank' });
  });

  it('saveSnapshot omits id when not provided', async () => {
    const sendCommand = vi.fn().mockResolvedValue({ snapshot: {} });
    const page = createPage(sendCommand);

    await page.saveSnapshot();

    expect(sendCommand).toHaveBeenCalledWith('Snapshot.capture', {});
  });

  it('restoreSnapshot unwraps a full capture result', async () => {
    const sendCommand = vi.fn().mockResolvedValue({});
    const page = createPage(sendCommand);

    await page.restoreSnapshot({ id: 'x', snapshot: { url: 'u' } });

    expect(sendCommand).toHaveBeenCalledWith('Snapshot.restore', { snapshot: { url: 'u' } });
  });

  it('restoreSnapshot accepts a bare blob', async () => {
    const sendCommand = vi.fn().mockResolvedValue({});
    const page = createPage(sendCommand);

    await page.restoreSnapshot({ url: 'u' });

    expect(sendCommand).toHaveBeenCalledWith('Snapshot.restore', { snapshot: { url: 'u' } });
  });

  it('deleteSnapshot sends Snapshot.delete with the id', async () => {
    const sendCommand = vi.fn().mockResolvedValue({ deleted: true });
    const page = createPage(sendCommand);

    await page.deleteSnapshot('s1');

    expect(sendCommand).toHaveBeenCalledWith('Snapshot.delete', { id: 's1' });
  });
});
