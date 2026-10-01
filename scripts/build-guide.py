#!/usr/bin/env python3
"""
Construit LE guide unique : docs/GUIDE-MISE-EN-LIGNE.pdf

  npm run guide          (equivalent : python3 scripts/build-guide.py)

Il assemble : docs/GUIDE-MISE-EN-LIGNE.md  +  les 4 fichiers SQL de db/supabase/  +  .env.production.local
Les secrets ne vivent que dans le PDF généré localement (le .pdf est dans .gitignore, le .md versionné
contient des placeholders) : un guide qu on envoie par mail ne doit pas emporter les cles.

Marques prises en charge dans le markdown :
  @@SQL:<chemin>@@        -> remplace par le contenu du fichier, en bloc code
  @@ENV@@                 -> contenu de .env.production.local, ou des placeholders si le fichier est absent
  @@WHEN@@                -> date de generation lisible
"""
from __future__ import annotations

import html
import os
import re
import subprocess
import sys
from datetime import datetime, timezone
from zoneinfo import ZoneInfo
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "docs" / "GUIDE-MISE-EN-LIGNE.md"
OUT = ROOT / "docs" / "GUIDE-MISE-EN-LIGNE.pdf"
ENVFILE = ROOT / ".env.production.local"

PLACEHOLDERS = """# Secret de session : a generer (openssl rand -hex 32) et coller dans Vercel
SESSION_SECRET=<a-generer>
TOKEN_SECRET=<a-generer>
CRON_SECRET=<a-generer>
DATABASE_URL=<postgres://…?sslmode=require>   # a coller dans Vercel, jamais dans un fichier du depot
PG_POOL_MAX=5
APP_URL=https://rdv.zyass-barber.fr
TIMEZONE=Europe/Paris
DEMO_SLUG=zyass
TRUST_PROXY=1"""


def read_sql(rel: str) -> str:
    p = ROOT / rel
    if not p.exists():
        raise SystemExit(f"✗ fichier absent : {rel} — lancer `npm run db:sql` avant le guide")
    return p.read_text(encoding="utf-8").rstrip()


def inject(md: str) -> str:
    md = re.sub(
        r"@@SQL:(.+?)@@",
        lambda m: "```sql\n" + read_sql(m.group(1).strip()) + "\n```",
        md,
    )
    env = ENVFILE.read_text(encoding="utf-8").strip() if ENVFILE.exists() else PLACEHOLDERS
    md = md.replace("@@ENV@@", "```ini\n" + env + "\n```")
    admin_file = ROOT / ".env.admin.local"
    admin = admin_file.read_text(encoding="utf-8").strip() if admin_file.exists() else "ADMIN_EMAIL=<votre-identifiant>\nADMIN_PASSWORD=<votre-mot-de-passe>"
    md = md.replace("@@ADMIN@@", "```ini\n" + admin + "\n```")
    md = md.replace("@@ENVREF@@", "```ini\n" + (ROOT / ".env.example").read_text(encoding="utf-8") + "\n```")
    cron = "<CRON_SECRET>"
    if ENVFILE.exists():
        m = re.search(r"^CRON_SECRET=(\S+)", ENVFILE.read_text(encoding="utf-8"), re.M)
        if m:
            cron = m.group(1)
    md = md.replace("@@CRON@@", cron)
    when = datetime.now(ZoneInfo("Europe/Paris")).strftime("%d/%m/%Y à %H:%M (Europe/Paris)")
    md = md.replace("@@WHEN@@", when)
    return md


CSS = """
@page {
  size: A4; margin: 17mm 15mm 16mm 15mm;
  @top-center { content: "Z YASS BARBER SHOP — guide de déploiement (Supabase + Vercel)";
                font-size: 7.6pt; color: #7a7f8a; letter-spacing: .02em; }
  @bottom-right { content: "page " counter(page) " / " counter(pages); font-size: 7.6pt; color: #7a7f8a; }
}
@page cover { margin: 0; @top-center { content: none } @bottom-right { content: none } }
html { font-size: 10.4pt; }
body { font-family: "DejaVu Sans", "Liberation Sans", system-ui, sans-serif; color: #14161b; line-height: 1.42; }
h1, h2, h3, h4 { font-family: "DejaVu Serif", Georgia, serif; color: #0b0b0d; line-height: 1.2; }
h1 { font-size: 19pt; margin: 0 0 .4em; }
h2 { font-size: 14.5pt; margin: 1.5em 0 .45em; padding-bottom: .18em; border-bottom: 1.4pt solid #c9a253; }
h3 { font-size: 11.6pt; margin: 1.15em 0 .3em; color: #33383f; }
h4 { font-size: 10.6pt; margin: .95em 0 .25em; color: #4b5158; }
p, li { text-align: justify; }
ul, ol { padding-left: 1.15em; }
li { margin: .18em 0; }
code { font-family: "DejaVu Sans Mono", monospace; font-size: .88em; background: #f2f3f5; padding: 0 .18em; border-radius: 2px; }
pre { background: #f7f7f8; border-left: 2.6pt solid #c9a253; padding: .5em .65em; margin: .55em 0;
      white-space: pre-wrap; word-break: break-word; font-size: 7.4pt; line-height: 1.3;
      orphans: 2; widows: 2; }
pre code { background: none; padding: 0; font-size: inherit; }
table { width: 100%; border-collapse: collapse; margin: .6em 0 .8em; font-size: 8.9pt; }
th { background: #0b0b0d; color: #f4e9d6; text-align: left; font-weight: 600; }
th, td { border: .5pt solid #cfd3da; padding: .3em .42em; vertical-align: top; }
tr:nth-child(even) td { background: #fafafa; }
blockquote { margin: .6em 0; padding: .45em .7em; background: #fbf6ea; border-left: 2.6pt solid #c9a253; font-size: 9.4pt; }
blockquote p { margin: .2em 0; }
hr { border: none; border-top: .5pt solid #d8dbe1; margin: 1.1em 0; }
a { color: #1c4e8a; text-decoration: none; }
.warn { background: #fff4f2; border: .6pt solid #e0a79c; border-left: 3pt solid #b3402a; padding: .5em .7em; margin: .6em 0; font-size: 9.3pt; }
.cover { page: cover; height: 297mm; padding: 0; margin: 0; background: #0b0b0d; color: #f4e9d6; }
.cover .in { padding: 34mm 20mm; }
.cover .brand { font-size: 9.5pt; letter-spacing: .32em; text-transform: uppercase; color: #c9a253; }
.cover h1 { color: #fff; font-size: 26pt; margin: .55em 0 .25em; }
.cover .sub { font-size: 12pt; color: #c9ced8; }
.cover .meta { margin-top: 26mm; font-size: 9pt; color: #9aa1ad; line-height: 1.7; }
.cover .gold { width: 62mm; height: 2.4pt; background: #c9a253; margin: 8mm 0; }
.cover .alert { margin-top: 16mm; background: #17181d; border-left: 3pt solid #c9a253; padding: .7em .9em; font-size: 9.2pt; color: #e8e3d7; }
.kpi { display: flex; gap: 4mm; margin-top: 9mm; }
.kpi div { flex: 1; background: #17181d; border: .5pt solid #2c2e35; padding: .55em .7em; border-radius: 3px; }
.kpi b { display: block; font-size: 14pt; color: #c9a253; font-family: "DejaVu Serif", Georgia, serif; }
.kpi span { font-size: 8.2pt; color: #b9bfc9; }
section { break-inside: auto; }
h2 { break-after: avoid; }
h3, h4 { break-after: avoid; }
table, blockquote { break-inside: avoid; }
pre { break-inside: auto; }   /* les blocs SQL font 800 lignes : interdire la coupure = pages blanches */
.sqlfile { break-before: page; }
"""


def main() -> int:
    if not SRC.exists():
        raise SystemExit(f"✗ source absente : {SRC}")
    try:
        import markdown  # type: ignore
        from weasyprint import HTML  # type: ignore
    except Exception as e:  # noqa: BLE001
        print(f"✗ outillage PDF manquant ({type(e).__name__}: {e})")
        print("  installation : python3 -m pip install --break-system-packages markdown weasyprint")
        return 1
    body = markdown.markdown(inject(SRC.read_text(encoding="utf-8")), extensions=["tables", "fenced_code", "sane_lists"])
    # Titres de sections SQL en tête de page (le bloc « ```sql » précédent garde son échappement brut)
    body = re.sub(r"<h2>(6\.[^<]*SQL[^<]*)</h2>", r'<h2 class="sqlfile">\1</h2>', body, count=1)
    doc = f"""<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>Guide de déploiement — Z YASS BARBER SHOP</title>
<style>{CSS}</style></head><body>{body}</body></html>"""
    (ROOT / "docs" / ".guide-build.html").write_text(doc, encoding="utf-8")
    HTML(string=doc, base_url=str(ROOT)).write_pdf(str(OUT))
    size = OUT.stat().st_size
    try:
        info = subprocess.run(["pdfinfo", str(OUT)], capture_output=True, text=True).stdout
        pages = re.search(r"Pages:\s+(\d+)", info)
        n = pages.group(1) if pages else "?"
    except Exception:  # noqa: BLE001
        n = "?"
    print(f"✓ {OUT.relative_to(ROOT)} — {n} page(s), {size / 1024:.0f} ko · source : {SRC.name}"
          + (" · secrets injectés depuis .env.production.local" if ENVFILE.exists() else " · placeholders (aucun .env.production.local)"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
