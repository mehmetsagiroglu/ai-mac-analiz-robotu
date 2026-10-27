
export async function onRequestGet(context) {
  const key = context.env.APIFOOTBALL_KEY;

  if (!key) {
    return Response.json({
      ok: false,
      message: "APIFOOTBALL_KEY bulunamadı."
    }, { status: 500 });
  }

  try {
    const response = await fetch(
      "https://v3.football.api-sports.io/status",
      {
        headers: {
          "x-apisports-key": key
        },
        signal: AbortSignal.timeout(10000)
      }
    );

    const data = await response.json();

    return Response.json({
      http_status: response.status,
      api_errors: data.errors || {},
      account: data.response || null
    });
  } catch {
    return Response.json({
      ok: false,
      message: "API bağlantı isteği başarısız oldu."
    }, { status: 502 });
  }
}
