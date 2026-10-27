
export async function onRequestGet(context) {
  const key = context.env.APIFOOTBALL_KEY;

  if (!key) {
    return Response.json(
      {
        ok: false,
        message: "APIFOOTBALL_KEY bulunamadi."
      },
      { status: 500 }
    );
  }

  try {
    const response = await fetch(
      "https://v3.football.api-sports.io/status",
      {
        method: "GET",
        headers: {
          "x-apisports-key": key
        }
      }
    );

    const data = await response.json();

    return Response.json({
      http_status: response.status,
      api_errors: data.errors || {},
      account: data.response || null
    });
  } catch (error) {
    return Response.json(
      {
        ok: false,
        message: "API baglanti istegi basarisiz oldu."
      },
      { status: 502 }
    );
  }
}
