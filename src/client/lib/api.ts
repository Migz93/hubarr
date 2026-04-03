const JSON_HEADERS = {
  "Content-Type": "application/json"
};

async function parseResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    let message = `Request failed: ${response.status}`;
    try {
      const body = (await response.json()) as { error?: string };
      if (body.error) {
        message = body.error;
      }
    } catch {
      // ignore parse failures
    }
    throw new Error(message);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return (await response.json()) as T;
}

export async function apiGet<T>(url: string) {
  const response = await fetch(url, {
    credentials: "include"
  });
  return parseResponse<T>(response);
}

export async function apiPost<T>(url: string, body?: unknown) {
  const response = await fetch(url, {
    method: "POST",
    credentials: "include",
    headers: JSON_HEADERS,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return parseResponse<T>(response);
}

export async function apiPatch<T>(url: string, body: unknown) {
  const response = await fetch(url, {
    method: "PATCH",
    credentials: "include",
    headers: JSON_HEADERS,
    body: JSON.stringify(body)
  });
  return parseResponse<T>(response);
}

export async function apiDelete<T>(url: string) {
  const response = await fetch(url, {
    method: "DELETE",
    credentials: "include"
  });
  return parseResponse<T>(response);
}
