/**
 * Turns a failed connect into something a reader can act on.
 *
 * The SDK reports what actually happened — `TypeError: Failed to fetch`, or a
 * bare HTTP status — which is accurate and useless. Every one of these failures
 * has exactly one likely cause on a first run, and saying it out loud is the
 * difference between a two-second fix and a debugging session.
 */
export interface ConnectionTarget {
  whipUrl: string;
  tokenUrl?: string;
}

/** First-pass reading, available immediately. */
export function describeConnectError(error: Error, target: ConnectionTarget): string {
  const message = error.message;

  const status = message.match(/failed \((\d{3})\)/)?.[1];
  if (status === "401" || status === "403") {
    return target.tokenUrl
      ? `The server rejected the token from ${target.tokenUrl}. Check that NEXT_PUBLIC_API_KEY matches the server's api_key.`
      : `The server requires authentication. Set NEXT_PUBLIC_TOKEN_URL (and NEXT_PUBLIC_API_KEY if the server sets one) in .env.local — see .env.local.example.`;
  }
  if (status === "404") {
    return `${target.whipUrl} returned 404. Check NEXT_PUBLIC_WHIP_URL points at the server's /whip endpoint.`;
  }
  if (status) {
    return `The server answered ${status}. ${message}`;
  }

  if (isNetworkFailure(message)) {
    return `Could not reach ${target.whipUrl}. Checking why…`;
  }
  return message;
}

/**
 * Second pass, once a probe has had a chance to run. A plain fetch failure
 * cannot distinguish "nothing is listening" from "something is listening and
 * the browser refused to talk to it", so ask.
 */
export async function diagnoseConnectError(
  error: Error,
  target: ConnectionTarget
): Promise<string | null> {
  if (!isNetworkFailure(error.message)) return null;

  const reachable = await canReach(target.whipUrl);
  if (reachable) {
    return (
      `${target.whipUrl} is reachable, but the browser blocked the request. ` +
      `This is usually CORS — the server must allow this page's origin.`
    );
  }

  const insecure =
    typeof window !== "undefined" &&
    window.location.protocol === "https:" &&
    target.whipUrl.startsWith("http://");

  return (
    `Could not reach the StreamCore server at ${target.whipUrl}. Start it, then try again.` +
    (insecure
      ? ` This page is served over HTTPS; some browsers also refuse to call an HTTP endpoint from one, even on localhost.`
      : "")
  );
}

function isNetworkFailure(message: string): boolean {
  // Chrome says "Failed to fetch", Firefox "NetworkError when attempting to
  // fetch resource", Safari "Load failed".
  return /failed to fetch|networkerror|load failed|fetch failed/i.test(message);
}

/**
 * Is anything answering at all?
 *
 * `no-cors` is the point: it returns an opaque response the caller cannot read,
 * but it resolves rather than rejecting when a server is there, which is the
 * only bit that matters. A CORS rejection would otherwise look identical to
 * nothing listening.
 */
async function canReach(url: string): Promise<boolean> {
  try {
    await fetch(url, { method: "OPTIONS", mode: "no-cors", cache: "no-store" });
    return true;
  } catch {
    return false;
  }
}
