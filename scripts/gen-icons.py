"""Regénère les exports à partir du logo choisi (Pillow requis, pas exécuté au build Vercel)."""
from pathlib import Path
from PIL import Image
import base64
root = Path(__file__).resolve().parent.parent / 'client/public'
source = Image.open(root / 'brand/logo-source.png').convert('RGB')
# Recadrage du monogramme sélectionné, centré avec zone de sécurité PWA.
source = source.crop((155, 160, 855, 860))
for rel, size in [('brand/logo.png',512), ('brand/icon-192.png',192), ('icon-192.png',192), ('icon-512.png',512), ('brand/apple-touch-icon.png',180), ('brand/favicon-32.png',32)]:
    source.resize((size,size), Image.Resampling.LANCZOS).save(root / rel, optimize=True)
source.resize((256,256), Image.Resampling.LANCZOS).save(root / 'favicon.ico', sizes=[(16,16),(32,32),(48,48),(64,64),(128,128),(256,256)])
png = base64.b64encode((root / 'brand/icon-192.png').read_bytes()).decode()
(root / 'brand/favicon.svg').write_text(f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 192 192"><title>Z.YASS</title><image width="192" height="192" href="data:image/png;base64,{png}"/></svg>')
print('Logo choisi décliné : favicon SVG/ICO/PNG, Apple et PWA.')
