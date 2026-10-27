
const ALLOWED = [
  "nowgoal.net",
  "nowgoal.com",
  "nowgoal26.com",
  "nowgoal828.com",
  "nowgoal.plus",
  "nowgoal831.com"
];

const API = "https://api.openligadb.de";

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

function clean(s = "") {
  return s
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
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
    const p = t.split(re);
    if (p.length === 2 && p.every(x => x.trim().length > 1)) {
      return p.map(x => x.trim());
    }
  }
  return null;
}

function norm(s = "") {
  return s.toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9 ]/g, "")
    .replace(/\b(fc|cf|sc|afc|club)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

async function getJson(path) {
  const r = await fetch(API + path, {
    headers: { "Accept": "application/json" },
    signal: AbortSignal.timeout(10000)
  });

  if (!r.ok) throw new Error("OpenLigaDB HTTP " + r.status);

  return r.json();
}

function score(m) {
  const results = Array.isArray(m.matchResults)
    ? m.matchResults
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

  const goals = Array.isArray(m.goals) ? m.goals : [];
  if (goals.length) {
    const h = goals.filter(g =>
      Number(g.scoreTeam1) > Number(g.scoreTeam2)
    ).length;
    const a = goals.filter(g =>
      Number(g.scoreTeam2) > Number(g.scoreTeam1)
    ).length;

    if (goals.every(g =>
      Number.isFinite(Number(g.scoreTeam1)) &&
      Number.isFinite(Number(g.scoreTeam2))
    )) return [h, a];
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

async function teamMatches(name) {
  const rows = await getJson(
    "/getmatchesbyteam/" +
    encodeURIComponent(name) + "/20/0"
  );
  return finished(rows);
}

function teamStats(rows, teamName) {
  const n = norm(teamName);
  const played = rows.map(m => {
    const h = norm(m.team1?.teamName || "");
    const a = norm(m.team2?.teamName || "");
    const s = score(m);

    if (!s || (h !== n && a !== n)) return null;

    return {
      home: h === n,
      gf: h === n ? s[0] : s[1],
      ga: h === n ? s[1] : s[0],
      opponent: h === n ? m.team2?.teamName : m.team1?.teamName,
      date: m.matchDateTime,
      score: s
    };
  }).filter(Boolean);

  const mean = (xs, fn) => xs.length
    ? Math.round(xs.reduce((a, x) => a + fn(x), 0) /
        xs.length * 100) / 100
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

function poisson(lambda, k) {
  let p = Math.exp(-lambda);
  for (let i = 1; i <= k; i++) p *= lambda / i;
  return p;
}

function predictions(homeLambda, awayLambda) {
  const hp = Array.from({length: 7}, (_, i) =>
    poisson(homeLambda, i));
  const ap = Array.from({length: 7}, (_, i) =>
    poisson(awayLambda, i));

  let over = 0, btts = 0, home = 0, draw = 0, away = 0;
  let best = { score: "0-0", p: -1 };

  for (let h = 0; h <= 6; h++) {
    for (let a = 0; a <= 6; a++) {
      const p = hp[h] * ap[a];

      if (h + a >= 3) over += p;
      if (h > 0 && a > 0) btts += p;
      if (h > a) home += p;
      else if (h === a) draw += p;
      else away += p;

      if (p > best.p) best = { score: `${h}-${a}`, p };
    }
  }

  const pct = x => Math.round(x * 100);

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

  if (!["https:", "http:"].includes(parsed.protocol) ||
      !ALLOWED.some(d => host === d || host.endsWith("." + d))) {
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
        "Nowgoal sayfası okunamadı. Site erişimi engelliyor olabilir.",
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
        "Takım adları maç bağlantısından alınamadı.",
        url
      );
    }
  } catch {
    return result(
      "Nowgoal sunucusuna erişilemedi. Takım adları okunamadı.",
      url
    );
  }

  try {
    const results = await Promise.allSettled([
      teamMatches(names[0]),
      teamMatches(names[1])
    ]);

    if (results.some(x => x.status === "rejected")) {
      return result(
        "Ücretsiz kaynaklardan veri alınamadı. Daha sonra tekrar dene.",
        url,
        { teams: { home: names[0], away: names[1] } }
      );
    }

    const homeRows = results[0].value;
    const awayRows = results[1].value;

    const hs = teamStats(homeRows, names[0]);
    const as = teamStats(awayRows, names[1]);

    if (hs.count < 3 || as.count < 3) {
      return result(
        "OpenLigaDB bu takımlar için yeterli geçmiş maç bulamadı. Tahmin üretilmedi.",
        url,
        {
          teams: { home: names[0], away: names[1] },
          stats: {
            home_sample: hs.count,
            away_sample: as.count,
            data_source: "OpenLigaDB"
          }
        }
      );
    }

    const homeGF = hs.home_gf ?? hs.gf;
    const homeGA = hs.home_ga ?? hs.ga;
    const awayGF = as.away_gf ?? as.gf;
    const awayGA = as.away_ga ?? as.ga;

    const lambdaH = (homeGF + awayGA) / 2;
    const lambdaA = (awayGF + homeGA) / 2;
    const pred = predictions(lambdaH, lambdaA);

    const h2h = hs.played.filter(m =>
      norm(m.opponent) === norm(names[1])
    );

    return Response.json({
      source_status: "verified",
      message: "Ücretsiz OpenLigaDB maç geçmişi kullanıldı. xG, şut ve sakatlık verileri bu kaynakta doğrulanmadı.",
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
          total_expected_280:
            lambdaH + lambdaA >= 2.80
        },
        data_source: "OpenLigaDB"
      },
      form: [
        { team: names[0], matches: hs.played.slice(0, 10) },
        { team: names[1], matches: as.played.slice(0, 10) }
      ],
      series: h2h.slice(0, 10)
    }, {
      headers: { "Cache-Control": "no-store" }
    });
  } catch {
    return result(
      "Ücretsiz veri kaynağına bağlanılamadı. Veriler olmadan tahmin yapılmadı.",
      url,
      { teams: { home: names[0], away: names[1] } }
    );
  }
}

