/** Un module ES refusé reste en échec dans React.lazy ET le navigateur.
 * Réarmer le boundary ne suffit pas : il faut un nouveau document. */
const KEY = 'zyass:asset-reload-at';
const PARAM = '_zyass_reload';
export function isAssetLoadError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module|Unable to preload CSS|Loading chunk .+ failed/i.test(message);
}
export function reloadDocument() {
  const url = new URL(window.location.href);
  url.searchParams.set(PARAM, String(Date.now())); // évite aussi un ancien HTML encore en cache
  window.location.replace(url.href);
}
export function recoverAssetOnce(): boolean {
  if (!navigator.onLine) return false;
  try {
    const previous = Number(sessionStorage.getItem(KEY) || 0);
    if (Date.now() - previous < 60_000) return false;
    sessionStorage.setItem(KEY, String(Date.now()));
  } catch { return false; } // pas de stockage => pas de boucle de rechargement automatique
  reloadDocument();
  return true;
}
export function installAssetRecovery() {
  const url = new URL(window.location.href);
  if (url.searchParams.has(PARAM)) {
    url.searchParams.delete(PARAM);
    window.history.replaceState(window.history.state, '', url.pathname + url.search + url.hash);
  }
  window.addEventListener('vite:preloadError', event => {
    if (recoverAssetOnce()) event.preventDefault();
  });
}
