export async function fetchWithRetry(
  url: URL | string,
  options?: RequestInit | undefined,
  maxRetries = 3
) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      let response = await fetch(url, options);
      if (!response.ok) throw new Error("Fetch Error");
      return response;
    } catch (error) {
      if (i === maxRetries - 1) throw error; // If it's the last retry, throw the error
    }
  }
}

export const getProductRouteFromTitle = (title: string) =>
  title.replaceAll("'", "").replaceAll(" ", "-")?.toLowerCase();
