
export async function onRequestGet(context) {
  const key = context.env.FOOTBALL_DATA_KEY;

  if (!key) {
    return Response.json({
      ok: false,
      message: "FOOTBALL_DATA_KEY bulunamadı."
    }, { status: 500 });
  }

  try {
    const response = await fetch(
      "https://api.football-data.org/v4/competitions",
      {
        headers: {
          "X-Auth-Token": key
        }
      }
    );

    const data = await response.json();

    return Response.json({
      http_status: response.status,
      api_errors: data.message || data.error || null,
      competition_count: Array.isArray(data.competitions)
        ? data.competitions.length
        : 0,
      competitions: Array.isArray(data.competitions)
        ? data.competitions.map(item => item.name)
        : []
    });
  } catch {
    return Response.json({
      ok: false,
      message: "API bağlantısı başarısız oldu."
    }, { status: 502 });
  }
}
