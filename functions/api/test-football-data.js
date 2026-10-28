
export async function onRequestGet(context) {
  const key = context.env.FOOTBALL_DATA_KEY;

  try {
    const response = await fetch(
      "https://api.football-data.org/v4/competitions",
      {
        headers: { "X-Auth-Token": key }
      }
    );

    const data = await response.json();

    return Response.json({
      http_status: response.status,
      competition_count: data.competitions?.length ?? 0,
      message: data.message ?? null,
      competitions: data.competitions?.map(c => c.name) ?? []
    });
  } catch {
    return Response.json({
      error: "API bağlantısı başarısız."
    }, { status: 502 });
  }
}
