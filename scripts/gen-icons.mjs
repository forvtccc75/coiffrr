/** Les exports sont déjà versionnés. Régénération locale facultative : Python 3 + Pillow.
 * Ne jamais remplacer le logo sélectionné par l'ancien monogramme géométrique.
 */
import { execFileSync } from 'node:child_process';
execFileSync('python3', ['scripts/gen-icons.py'], { stdio: 'inherit' });
