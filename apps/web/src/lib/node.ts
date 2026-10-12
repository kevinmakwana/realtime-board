/**
 * Demo/debug helper for the docker `scale` profile: opening `/?node=2` asks nginx to route this tab
 * to server-2. Remembered per tab (sessionStorage) so it survives in-app navigation.
 */
export function pinnedNode(): string | undefined {
  try {
    const fromUrl = new URLSearchParams(location.search).get('node');
    if (fromUrl && /^[0-9]{1,2}$/.test(fromUrl)) sessionStorage.setItem('rb.node', fromUrl);
    return sessionStorage.getItem('rb.node') ?? undefined;
  } catch {
    return undefined;
  }
}
