/**
 * @jest-environment jsdom
 */

require('../shared/storage.js');

describe('StorageManager', () => {
  beforeEach(() => {
    browser.storage.local.get.mockClear();
    browser.storage.local.set.mockClear();
  });

  test('getConfig returns defaults when nothing is stored', async () => {
    browser.storage.local.get.mockImplementation((key) => Promise.resolve({}));
    const storage = new StorageManager();
    const config = await storage.getConfig();
    expect(config).toMatchObject({
      serverUrl: '',
      deviceToken: '',
      syncEnabled: true
    });
  });

  test('setConfig stores the value', async () => {
    browser.storage.local.set.mockImplementation(() => Promise.resolve());
    const storage = new StorageManager();
    await storage.setConfig({ serverUrl: 'https://example.com' });
    expect(browser.storage.local.set).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({ serverUrl: 'https://example.com' })
      })
    );
  });
});
