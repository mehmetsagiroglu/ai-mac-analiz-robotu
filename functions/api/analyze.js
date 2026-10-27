const ALLOWED = ["nowgoal.net", "nowgoal.com", "nowgoal26.com", "nowgoal828.com", "nowgoal.plus", "nowgoal831.com"];

function emptyPayload(message, url) {
  return { source_status: "unavailable", message, url, teams: { home: "Ev sahibi", away: "Deplasman" }, stats: {}, form: [], series: [] };
}

function textOnly(html) {
  return html.replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ").replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&")
    .replace(/&#39;|&apos;/gi, "'").replace(/&quot;/gi, '"').replace(/\s+/g, " ").trim();
}

export async function onRequestPost({ request }) {
  let body;
  try { body = await request.json(); } catch { return Response.json({ error: "Geçersiz istek." }, { status: 400 }); }
  const url = String(body?.url || "").trim();
  let parsed;
  try { parsed = new URL(url); } catch { return Response.json(emptyPayload("Geçerli bir URL girin.", url), { status: 400 }); }
  const host = parsed.hostname.toLowerCase();
  if (!["http:", "https:"].includes(parsed.protocol) || !ALLOWED.some(d => host === d || host.endsWith("." + d))) {
    return Response.json(emptyPayload("Yalnızca tanınan Nowgoal bağlantıları kabul edilir.", url), { status: 400 });
  }

  let html;
  try {
    const r = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36",
        "Accept-Language": "en-US,en;q=0.9"
      },
      signal: AbortSignal.timeout(18000)
    });
    if (!r.ok) return Response.json(emptyPayload("Nowgoal isteği HTTP " + r.status + " ile reddedildi. Site erişimi kısıtlıyor olabilir.", url));
    html = (await r.text()).slice(0, 4000000);
  } catch {
    return Response.json(emptyPayload("Nowgoal sayfasına sunucudan erişilemedi. Site erişimi kısıtlıyor veya zaman aşımı yaşanmış olabilir.", url));
  }

  const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "")
    .replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  const text = textOnly(html);
  const data = emptyPayload("Sayfa alındı ancak bu sürüm sayfadan güvenilir takım istatistiklerini otomatik ayıklayamadı. Rastgele değer kullanılmadı.", url);
  const clean = title.replace(/\s*[-|]\s*(?:Nowgoal.*|Football.*|Live.*)$/i, "").trim();

  for (const sep of [" vs. ", " vs ", " VS ", " - "]) {
    if (clean.includes(sep)) {
      const bits = clean.split(sep, 2).map(x => x.trim());
      if (bits.length === 2 && bits.every(x => x.length > 2 && x.length < 90)) {
        data.teams = { home: bits[0], away: bits[1] };
        break;
      }
    }
  }

  const patterns = {
    home_goals_for: /(?:home|home team)[^\d]{0,45}(?:goals scored|goals for|scored per game)[^\d]{0,20}(\d+(?:\.\d+)?)/i,
    home_goals_against: /(?:home|home team)[^\d]{0,45}(?:goals conceded|goals against)[^\d]{0,20}(\d+(?:\.\d+)?)/i,
    away_goals_for: /(?:away|away team)[^\d]{0,45}(?:goals scored|goals for|scored per game)[^\d]{0,20}(\d+(?:\.\d+)?)/i,
    away_goals_against: /(?:away|away team)[^\d]{0,45}(?:goals conceded|goals against)[^\d]{0,20}(\d+(?:\.\d+)?)/i
  };
  for (const [key, re] of Object.entries(patterns)) {
    const m = text.match(re);
    if (m) data.stats[key] = Number(m[1]);
  }

  if (Object.keys(data.stats).length === 4) {
    data.source_status = "verified";
    data.message = "Gerekli dört gol ortalaması sayfadan okundu.";
  } else if (data.teams.home !== "Ev sahibi") {
    data.message = "Takım adları sayfa başlığından alındı; gol istatistikleri güvenilir biçimde okunamadı. Yüzdeler hesaplanmadı.";
  }
  return Response.json(data, { headers: { "Cache-Control": "no-store" } });
}
