
const ALLOWED = [
  "nowgoal.net",
  "nowgoal.com",
  "nowgoal26.com",
  "nowgoal828.com",
  "nowgoal.plus",
  "nowgoal831.com"
];

function result(message, url, extra = {}) {
  return Response.json({
    source_status: "unavailable",
    message,
    url,
    teams: { home: "Ev sahibi", away: "Deplasman" },
    stats: {},
    form: [],
    series: [],
    ...extra
  }, { headers: { "Cache-Control": "no-store" } });
}

function decode(s = "") {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
}

function cleanText(s = "") {
  return decode(s.replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ").trim();
}

function extractTeams(title) {
  let t = cleanText(title)
    .replace(/\s*[-|]\s*(Nowgoal.*|Football.*|Live.*)$/i, "")
    .trim();

  const separators = [
    /\s+vs\.?\s+/i,
    /\s+v\s+/i,
    /\s+-\s+/
  ];

  for (const re of separators) {
    const parts = t.split(re);
    if (parts.length === 2 &&
        parts.every(x => x.trim().length > 1)) {
      return parts.map(x => x.trim());
    }
  }
  return null;
}

async function api(path, key) {
  const r = await fetch("https://v3.football.api-sports.io/" + path, {
    headers: { "x-apisports-key": key }
  });

  const data = await r.json();

  if (!r.ok || (data.errors && Object.keys(data.errors).length)) {
    throw new Error("API-Football isteği başarısız oldu.");
  }
  return data.response || [];
}

function avg(rows, fn) {
  const values = rows.map(fn).filter(v =>
    typeof v === "number" && Number.isFinite(v)
  );
  if (!values.length) return null;
  return Math.round(
    values.reduce((a, b) => a + b, 0) / values.length * 100
  ) / 100;
}

async function findTeam(name, key) {
  const rows = await api(
    "teams?search=" + encodeURIComponent(name),
    key
  );

  if (!rows.length) return null;

  const norm = s => s.toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9 ]/g, "").trim();

  const wanted = norm(name);
  const exact = rows.find(x => norm(x.team.name) === wanted);

  return exact || rows[0];
}

async function recentFixtures(teamId, key) {
  return api(
    "fixtures?team=" + teamId + "&last=20",
    key
  );
}

function completed(rows) {
  return rows.filter(x =>
    x.goals &&
    x.goals.home !== null &&
    x.goals.away !== null &&
    ["FT", "AET", "PEN"].includes(x.fixture.status.short)
  );
}

function homeStats(rows, teamId) {
  const matches = completed(rows).filter(x =>
    Number(x.teams.home.id) === Number(teamId)
  );

  return {
    count: matches.length,
    gf: avg(matches, x => x.goals.home),
    ga: avg(matches, x => x.goals.away)
  };
}

function awayStats(rows, teamId) {
  const matches = completed(rows).filter(x =>
    Number(x.teams.away.id) === Number(teamId)
  );

  return {
    count: matches.length,
    gf: avg(matches, x => x.goals.away),
    ga: avg(matches, x => x.goals.home)
  };
}

export async function onRequestPost({ request, env }) {
  let body;

  try {
    body = await request.json();
  } catch {
    return result("İstek okunamadı.", "");
  }

  const url = String(body?.url || "").trim();
  let parsed;

  try {
    parsed = new URL(url);
  } catch {
    return result("Geçerli bir maç bağlantısı gir.", url);
  }

  const host = parsed.hostname.toLowerCase();

  if (
    !["https:", "http:"].includes(parsed.protocol) ||
    !ALLOWED.some(d => host === d || host.endsWith("." + d))
  ) {
    return result("Bu Nowgoal alan adı desteklenmiyor.", url);
  }

  const key = env.APIFOOTBALL_KEY;

  if (!key) {
    return result("APIFOOTBALL_KEY gizli değişkeni bulunamadı.", url);
  }

  let html;

  try {
    const page = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0",
        "Accept-Language": "en-US,en;q=0.9"
      },
      signal: AbortSignal.timeout(15000)
    });

    if (!page.ok) {
      return result(
        "Nowgoal sayfasına erişilemedi. Başka bir maç bağlantısı dene.",
        url
      );
    }

    html = (await page.text()).slice(0, 4000000);
  } catch {
    return result(
      "Nowgoal sunucudan okunamadı. Site erişimi engelliyor olabilir.",
      url
    );
  }

  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "";
  const names = extractTeams(title);

  if (!names) {
    return result(
      "Maç sayfasından takım adları alınamadı. Bu bağlantı biçimi desteklenmiyor.",
      url
    );
  }

  try {
    const [home, away] = await Promise.all([
      findTeam(names[0], key),
      findTeam(names[1], key)
    ]);

    if (!home || !away) {
      return result(
        "Takımlar API-Football veritabanında bulunamadı.",
        url,
        { teams: { home: names[0], away: names[1] } }
      );
    }

    const [homeRows, awayRows] = await Promise.all([
      recentFixtures(home.team.id, key),
      recentFixtures(away.team.id, key)
    ]);

    const hs = homeStats(homeRows, home.team.id);
    const as = awayStats(awayRows, away.team.id);

    if (
      hs.count < 3 ||
      as.count < 3 ||
      hs.gf === null ||
      hs.ga === null ||
      as.gf === null ||
      as.ga === null
    ) {
      return result(
        "Takımlar bulundu ancak ev/deplasman ortalamaları için yeterli tamamlanmış maç bulunamadı.",
        url,
        {
          teams: { home: home.team.name, away: away.team.name },
          stats: {
            home_sample: hs.count,
            away_sample: as.count
          }
        }
      );
    }

    const totalExpected = Math.round(
      (hs.gf + hs.ga + as.gf + as.ga) / 2 * 100
    ) / 100;

    return Response.json({
      source_status: "verified",
      message: "API-Football verileri alındı. Örneklem sayıları kontrol edilmeli.",
      url,
      teams: {
        home: home.team.name,
        away: away.team.name
      },
      stats: {
        home_goals_for: hs.gf,
        home_goals_against: hs.ga,
        away_goals_for: as.gf,
        away_goals_against: as.ga,
        home_sample: hs.count,
        away_sample: as.count,
        total_goal_expectation: totalExpected
      },
      form: [],
      series: []
    }, {
      headers: { "Cache-Control": "no-store" }
    });

  } catch (e) {
    return result(
      "API-Football veri isteği başarısız oldu. API anahtarını, günlük kotanı ve plan erişimini kontrol et.",
      url,
      { teams: { home: names[0], away: names[1] } }
    );
  }
}
