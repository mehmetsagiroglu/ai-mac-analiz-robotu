
const ALLOWED = [
  "nowgoal.net",
  "nowgoal.com",
  "nowgoal26.com",
  "nowgoal828.com",
  "nowgoal.plus",
  "nowgoal831.com"
];

const OPENLIGA = "https://api.openligadb.de";
const SPORTSDB = "https://www.thesportsdb.com/api/v1/json/123";

function result(message, url = "", extra = {}) {
  return Response.json({
    source_status: "unavailable",
    message,
    url,
    ...extra
  }, {
    headers: { "Cache-Control": "no-store" }
  });
}

function clean(value) {
  return String(value || "")
    .replace(/&amp;/gi, "&")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/&nbsp;/gi, " ")
    .replace(/&#(\d+);/g, (_, n) =>
      String.fromCodePoint(Number(n)))
    .replace(/<[^>]*>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function norm(value) {
  return clean(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\b(fc|cf|sc|afc|ac|sv|fk|sk|club)\b/g, "")
    .replace(/[^a-z0-9]+/g, "")
    .trim();
}

async function getJson(url) {
  const response = await fetch(url, {
    headers: { "Accept": "application/json" },
    signal: AbortSignal.timeout(10000)
  });

  if (!response.ok) {
    throw new Error("Veri kaynağı HTTP " + response.status);
  }

  return response.json();
}

function score(match) {
  const results = Array.isArray(match.matchResults)
    ? match.matchResults
    : [];

  const final = results.find(x =>
    Number(x.resultTypeID) === 2
  ) || results.find(x =>
    /final|end|90 minuten/i.test(x.resultName || "")
  );

  if (final &&
      Number.isFinite(Number(final.pointsTeam1)) &&
      Number.isFinite(Number(final.pointsTeam2))) {
    return [
      Number(final.pointsTeam1),
      Number(final.pointsTeam2)
    ];
  }

  return null;
}

function finished(rows) {
  return (Array.isArray(rows) ? rows : [])
    .filter(m => m.matchIsFinished && score(m))
    .sort((a, b) =>
      new Date(b.matchDateTime) - new Date(a.matchDateTime)
    );
}

function extractTeams(title) {
  const t = clean(title)
    .replace(/\s*[-|]\s*(Nowgoal.*|Football.*|Live.*)$/i, "")
    .trim();

  for (const re of [
    /\s+vs\.?\s+/i,
    /\s+v\s+/i,
    /\s+-\s+/
  ]) {
    const parts = t.split(re);
    if (parts.length === 2 &&
        parts.every(x => x.trim().length > 1)) {
      return parts.map(x => x.trim());
    }
  }

  return null;
}

async function openLigaMatches(name) {
  const rows = await getJson(
    OPENLIGA + "/getmatchesbyteam/" +
    encodeURIComponent(name) + "/20/0"
  );

  return finished(rows);
}

async function sportsDbMatches(name) {
  const search = await getJson(
    SPORTSDB + "/searchteams.php?t=" +
    encodeURIComponent(name)
  );

  const team = search?.teams?.[0];
  if (!team?.idTeam) return [];

  const response = await getJson(
    SPORTSDB + "/eventslast.php?id=" +
    encodeURIComponent(team.idTeam)
  );

  const events = Array.isArray(response?.results)
    ? response.results
    : Array.isArray(response?.events)
      ? response.events
      : [];

  const targetId = String(team.idTeam);

  return events.map(event => {
    const homeId = String(event.idHomeTeam || "");
    const awayId = String(event.idAwayTeam || "");

    if (homeId !== targetId && awayId !== targetId) {
      return null;
    }

    const homeScore = Number(event.intHomeScore);
    const awayScore = Number(event.intAwayScore);

    if (!Number.isFinite(homeScore) ||
        !Number.isFinite(awayScore) ||
        event.intHomeScore == null ||
        event.intAwayScore == null) {
      return null;
    }

    const homeName = clean(event.strHomeTeam);
    const awayName = clean(event.strAwayTeam);

    return {
      matchIsFinished: true,
      matchDateTime: event.dateEvent || event.strTimestamp || "",
      team1: { teamName: homeName },
      team2: { teamName: awayName },
      matchResults: [{
        resultTypeID: 2,
        resultName: "Final",
        pointsTeam1: homeScore,
        pointsTeam2: awayScore
      }]
    };
  }).filter(Boolean).sort((a, b) =>
    new Date(b.matchDateTime) - new Date(a.matchDateTime)
  );
}

async function teamMatches(name) {
  let primary = [];

  try {
    primary = await openLigaMatches(name);
    if (primary.length >= 3) return primary;
  } catch {
    // İkinci ücretsiz kaynak denenir.
  }

  try {
    const backup = await sportsDbMatches(name);
    if (backup.length >= 3) return backup;
  } catch {
    // Aşağıda veri yetersizliği açıkça bildirilir.
  }

  if (primary.length > 0) return primary;

  try {
    return await sportsDbMatches(name);
  } catch {
    return [];
  }
}

function teamStats(rows, teamName) {
  const target = norm(teamName);

  const played = rows.map(match => {
    const homeName = match.team1?.teamName || "";
    const awayName = match.team2?.teamName || "";
    const homeNorm = norm(homeName);
    const awayNorm = norm(awayName);
    const s = score(match);

    let isHome = homeNorm === target;
    let isAway = awayNorm === target;

    // Bazı kaynaklar takım adına ek kısaltma ekleyebilir.
    if (!isHome && !isAway) {
      isHome = homeNorm.includes(target) ||
        target.includes(homeNorm);
      isAway = awayNorm.includes(target) ||
        target.includes(awayNorm);
    }

    if (!s || (!isHome && !isAway)) return null;

    return {
      home: isHome,
      gf: isHome ? s[0] : s[1],
      ga: isHome ? s[1] : s[0],
      opponent: isHome ? awayName : homeName,
      date: match.matchDateTime,
      score: s
    };
  }).filter(Boolean);

  const mean = (items, fn) => items.length
    ? Math.round(
        items.reduce((total, item) => total + fn(item), 0) /
        items.length * 100
      ) / 100
    : null;

  const home = played.filter(x => x.home);
  const away = played.filter(x => !x.home);

  return {
    played,
    count: played.length,
    home_count: home.length,
    away_count: away.length,
    gf: mean(played, x => x.gf),
    ga: mean(played, x => x.ga),
    home_gf: mean(home, x => x.gf),
    home_ga: mean(home, x => x.ga),
    away_gf: mean(away, x => x.gf),
    away_ga: mean(away, x => x.ga)
  };
}

function poisson(lambda, goals) {
  let p = Math.exp(-lambda);
  for (let i = 1; i <= goals; i++) {
    p *= lambda / i;
  }
  return p;
}

function predictions(homeLambda, awayLambda) {
  const hp = Array.from({ length: 11 }, (_, i) =>
    poisson(homeLambda, i));
  const ap = Array.from({ length: 11 }, (_, i) =>
    poisson(awayLambda, i));

  let over = 0;
  let btts = 0;
  let home = 0;
  let draw = 0;
  let away = 0;
  let best = { score: "0-0", p: -1 };

  for (let h = 0; h <= 10; h++) {
    for (let a = 0; a <= 10; a++) {
      const p = hp[h] * ap[a];

      if (h + a >= 3) over += p;
      if (h > 0 && a > 0) btts += p;
      if (h > a) home += p;
      else if (h === a) draw += p;
      else away += p;

      if (p > best.p) {
        best = { score: `${h}-${a}`, p };
      }
    }
  }

  const pct = value => Math.round(value * 100);

  return {
    over25: pct(over),
    btts: pct(btts),
    home_win: pct(home),
    draw: pct(draw),
    away_win: pct(away),
    likely_score: best.score
  };
}

export async function onRequestPost({ request }) {
  let body;

  try {
    body = await request.json();
  } catch {
    return result("İstek okunamadı.");
  }

  const url = String(body?.url || "").trim();
  let parsed;

  try {
    parsed = new URL(url);
  } catch {
    return result("Geçerli bir maç bağlantısı gir.", url);
  }

  const host = parsed.hostname.toLowerCase();

  if (!["https:", "http:"].includes(parsed.protocol) ||
      !ALLOWED.some(d =>
        host === d || host.endsWith("." + d))) {
    return result("Bu Nowgoal alan adı desteklenmiyor.", url);
  }

  let names;

  try {
    const page = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0",
        "Accept-Language": "en-US,en;q=0.9"
      },
      signal: AbortSignal.timeout(12000)
    });

    if (!page.ok) {
      return result(
        "Nowgoal sayfası okunamadı; site otomatik erişimi engelliyor olabilir.",
        url
      );
    }

    const html = (await page.text()).slice(0, 4000000);
    const title = html.match(
      /<title[^>]*>([\s\S]*?)<\/title>/i
    )?.[1] || "";

    names = extractTeams(title);

    if (!names) {
      return result(
        "Takım adları bağlantıdan çıkarılamadı.",
        url
      );
    }
  } catch {
    return result(
      "Nowgoal sunucusuna erişilemedi. Takım adları okunamadı.",
      url
    );
  }

  const [homeRows, awayRows] = await Promise.all([
    teamMatches(names[0]),
    teamMatches(names[1])
  ]);

  const hs = teamStats(homeRows, names[0]);
  const as = teamStats(awayRows, names[1]);

  if (hs.count < 3 || as.count < 3) {
    return result(
      "Ücretsiz kaynaklarda yeterli geçmiş maç bulunamadı. Tahmin üretilmedi.",
      url,
      {
        teams: { home: names[0], away: names[1] },
        stats: {
          home_sample: hs.count,
          away_sample: as.count,
          data_sources: ["OpenLigaDB", "TheSportsDB"]
        }
      }
    );
  }

  const homeGF = hs.home_gf ?? hs.gf;
  const homeGA = hs.home_ga ?? hs.ga;
  const awayGF = as.away_gf ?? as.gf;
  const awayGA = as.away_ga ?? as.ga;

  if ([homeGF, homeGA, awayGF, awayGA].some(
    value => value == null || !Number.isFinite(value))) {
    return result("Takım istatistikleri eksik; tahmin üretilmedi.", url, {
      teams: { home: names[0], away: names[1] }
    });
  }

  const lambdaH = Math.max(0.05, (homeGF + awayGA) / 2);
  const lambdaA = Math.max(0.05, (awayGF + homeGA) / 2);
  const pred = predictions(lambdaH, lambdaA);

  const h2h = hs.played.filter(m =>
    norm(m.opponent) === norm(names[1])
  );

  const source = [
    ...homeRows.map(m => "OpenLigaDB"),
    ...awayRows.map(m => "OpenLigaDB")
  ];

  return Response.json({
    source_status: "estimated",
    message:
      "Tahminler geçmiş gol ortalamalarından hesaplandı. xG, şut, büyük fırsat ve sakatlık verileri doğrulanmadı. Ücretsiz kaynakların kapsamı sınırlıdır.",
    url,
    teams: { home: names[0], away: names[1] },
    stats: {
      home_goals_for: homeGF,
      home_goals_against: homeGA,
      away_goals_for: awayGF,
      away_goals_against: awayGA,
      home_sample: hs.count,
      away_sample: as.count,
      total_goal_expectation:
        Math.round((lambdaH + lambdaA) * 100) / 100,
      btts_probability: pred.btts,
      over25_probability: pred.over25,
      home_win_probability: pred.home_win,
      draw_probability: pred.draw,
      away_win_probability: pred.away_win,
      likely_score: pred.likely_score,
      three_filter: {
        home_ga_125: homeGA >= 1.25,
        away_gf_120: awayGF >= 1.20,
        total_expected_280: lambdaH + lambdaA >= 2.80
      },
      data_sources: ["OpenLigaDB", "TheSportsDB"]
    },
    form: [
      { team: names[0], matches: hs.played.slice(0, 10) },
      { team: names[1], matches: as.played.slice(0, 10) }
    ],
    series: h2h.slice(0, 10)
  }, {
    headers: { "Cache-Control": "no-store" }
  });
}

