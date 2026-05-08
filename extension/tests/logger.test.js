/**
 * @jest-environment jsdom
 */

describe('logger', () => {
  test('logger is defined globally', () => {
    expect(typeof logger).toBe('object');
    expect(typeof logger.log).toBe('function');
    expect(typeof logger.info).toBe('function');
    expect(typeof logger.warn).toBe('function');
    expect(typeof logger.error).toBe('function');
  });

  test('logger.warn redacts tokens in strings', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    logger.warn('Request to https://example.com/api?token=abc123');
    expect(warnSpy).toHaveBeenCalledWith(
      'Request to https://example.com/api?token=<redacted>'
    );
    warnSpy.mockRestore();
  });

  test('logger.error redacts Bearer tokens', () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    logger.error('Auth failed', 'Authorization: Bearer secret-token-123');
    expect(errorSpy).toHaveBeenCalledWith(
      'Auth failed',
      'Authorization: Bearer <redacted>'
    );
    errorSpy.mockRestore();
  });
});
