export async function onRequestGet(context) {
  return Response.json({
    environment_available: !!context.env,
    variable_names: Object.keys(context.env || {})
  });
}
