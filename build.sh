#!/bin/bash
# Пересобирает версию для хостинга из index.html.
# Запуск:  bash build.sh
set -e
cd "$(dirname "$0")"

python3 - <<'PY'
import pathlib, re

src = pathlib.Path('index.html').read_text(encoding='utf-8')

head_links = (
'<link rel="manifest" href="manifest.webmanifest">\n'
'<link rel="apple-touch-icon" href="icon-192.png">\n'
'<link rel="icon" href="icon-512.png" type="image/png">\n'
)
sw = (
'<script>\n'
"if('serviceWorker' in navigator)\n"
"  addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(()=>{}));\n"
'</script>\n'
)

out = src.replace('</head>', head_links + '</head>', 1).replace('</body>', sw + '</body>', 1)
pathlib.Path('docs/index.html').write_text(out, encoding='utf-8')
print('docs/index.html:', len(out), 'байт')
PY

echo "Готово. Содержимое папки docs/ можно выкладывать на любой статический хостинг."
ls -la docs/
