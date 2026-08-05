/**
 * MetalCut Vision Proxy — Cloudflare Worker
 * ------------------------------------------------------------
 * Держит ключ OpenAI на сервере. Страница MetalCut (GitHub Pages)
 * присылает сюда фото листка (эскиз или рукописный список),
 * воркер обращается к OpenAI Vision, получает и возвращает JSON
 * с исходным листом и списком деталей.
 *
 * Ключ ХРАНИТСЯ ТОЛЬКО ЗДЕСЬ (Cloudflare secret), в браузер клиента
 * не попадает никогда — в этом и есть смысл прокси.
 *
 * Настройка (один раз):
 *   1. npm install -g wrangler
 *   2. wrangler login
 *   3. cd worker && wrangler secret put OPENAI_API_KEY   (вставить ключ)
 *   4. wrangler deploy
 *   5. Скопировать выданный URL (вида https://metalcut-vision.<акк>.workers.dev)
 *      и вписать его в index.html как RECOGNIZE_URL.
 *
 * Защита: запросы принимаются только с разрешённых доменов (ALLOWED_ORIGINS).
 * Это не железная защита (Origin можно подделать вне браузера через curl),
 * но отсекает обычное копирование ссылки и случайное использование чужими
 * сайтами. Для более серьёзной защиты добавьте лимит запросов (KV) —
 * см. комментарий внизу файла.
 */

const ALLOWED_ORIGINS = [
  'https://amuravschi-cloud.github.io',
  'http://localhost:8000',      // для локальной проверки
  'http://127.0.0.1:8000',
];

const MODEL = 'gpt-4o';          // точнее на рукописном тексте, чем gpt-4o-mini
const MAX_IMAGE_BYTES = 8 * 1024 * 1024; // 8 МБ после сжатия на клиенте — с запасом

const SYSTEM_PROMPT = `Ты помогаешь оператору листогибочного/раскроечного цеха.
На фото — рукописный эскиз или список для раскроя листового металла.
Два возможных случая:
1) Нарисован от руки лист с расположенными на нём деталями (эскиз раскроя).
2) Просто написан текст: размер исходного листа и список деталей с размерами и количеством.

Извлеки данные и верни СТРОГО JSON без пояснений, в следующей форме:
{
  "order": "название заказа, если указано, иначе пустая строка",
  "sheet": { "length": число_мм, "width": число_мм, "kerf": число_мм_или_0, "trim": число_мм_или_0 } | null,
  "parts": [ { "name": "строка", "len": число_мм, "wid": число_мм, "qty": целое_число } ]
}

Правила:
- Все размеры — в миллиметрах. Если указаны в см или м — пересчитай в мм.
- "length"/"len" — большая или первая указанная сторона, "width"/"wid" — вторая.
- Если размер исходного листа не найден нигде на фото — верни "sheet": null.
- Если явного названия детали нет — придумай короткое понятное имя по её роли или порядку ("Панель", "Деталь 1"...).
- Если количество не указано явно — считай его равным 1.
- Толщина реза (kerf) и обрезка кромки (trim) на эскизе почти никогда не пишутся — оставляй 0, если не найдены явно.
- Если на фото несколько одинаковых деталей нарисованы по отдельности — сложи их в одну строку с суммарным qty, либо перечисли отдельно — как удобнее для точности.
- Не придумывай данные, которых нет на фото. Если совсем ничего не разобрать — верни "parts": [].
- Ответ — только JSON, без markdown-разметки, без \`\`\`.`;

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return withCors(new Response(null, { status: 204 }), request);
    if (request.method !== 'POST') return withCors(json({ error: 'method_not_allowed' }, 405), request);

    const origin = request.headers.get('Origin') || '';
    if (!ALLOWED_ORIGINS.includes(origin)) {
      return withCors(json({ error: 'origin_not_allowed' }, 403), request);
    }

    let body;
    try { body = await request.json(); }
    catch { return withCors(json({ error: 'bad_json' }, 400), request); }

    const { image, mime } = body || {};
    if (!image || typeof image !== 'string') {
      return withCors(json({ error: 'no_image' }, 400), request);
    }
    // грубая проверка размера base64 (~4/3 от бинарного размера)
    if (image.length > MAX_IMAGE_BYTES * 1.4) {
      return withCors(json({ error: 'image_too_large' }, 413), request);
    }
    const mediaType = (mime && /^image\/(png|jpe?g|webp)$/.test(mime)) ? mime : 'image/jpeg';

    if (!env.OPENAI_API_KEY) {
      return withCors(json({ error: 'server_not_configured' }, 500), request);
    }

    let openaiRes;
    try {
      openaiRes = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${env.OPENAI_API_KEY}`,
        },
        body: JSON.stringify({
          model: MODEL,
          temperature: 0,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            {
              role: 'user',
              content: [
                { type: 'text', text: 'Распознай этот эскиз/список раскроя и верни JSON по описанной схеме.' },
                { type: 'image_url', image_url: { url: `data:${mediaType};base64,${image}`, detail: 'high' } },
              ],
            },
          ],
          max_tokens: 2000,
        }),
      });
    } catch (e) {
      return withCors(json({ error: 'openai_unreachable', detail: String(e) }, 502), request);
    }

    if (!openaiRes.ok) {
      const detail = await openaiRes.text().catch(() => '');
      return withCors(json({ error: 'openai_error', status: openaiRes.status, detail: detail.slice(0, 500) }, 502), request);
    }

    const data = await openaiRes.json();
    const raw = data?.choices?.[0]?.message?.content;
    if (!raw) return withCors(json({ error: 'empty_response' }, 502), request);

    let parsed;
    try { parsed = JSON.parse(raw); }
    catch { return withCors(json({ error: 'unparseable_response', raw: raw.slice(0, 800) }, 502), request); }

    return withCors(json({ result: parsed }), request);
  },
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}

function withCors(res, request) {
  const origin = request.headers.get('Origin') || '';
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  const h = new Headers(res.headers);
  h.set('Access-Control-Allow-Origin', allowed);
  h.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  h.set('Access-Control-Allow-Headers', 'Content-Type');
  h.set('Vary', 'Origin');
  return new Response(res.body, { status: res.status, headers: h });
}

/* ------------------------------------------------------------
 * Опционально: дневной лимит запросов, чтобы случайно не спалить
 * весь баланс OpenAI при утечке URL. Требует KV namespace:
 *   wrangler kv:namespace create METALCUT_LIMIT
 * и привязки в wrangler.toml. Пример проверки в начале fetch():
 *
 *   const key = 'day:' + new Date().toISOString().slice(0,10);
 *   const used = parseInt(await env.METALCUT_LIMIT.get(key) || '0', 10);
 *   if (used >= 100) return withCors(json({error:'daily_limit'}, 429), request);
 *   await env.METALCUT_LIMIT.put(key, String(used + 1), {expirationTtl: 172800});
 * ------------------------------------------------------------ */
