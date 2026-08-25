export function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...extraHeaders },
  });
}

export function err(message, status = 400) {
  return json({ error: message }, status);
}

export async function readJSON(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}
