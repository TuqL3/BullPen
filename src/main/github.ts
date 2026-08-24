/**
 * Signing in to GitHub from a desktop app, without a server.
 *
 * The web flow needs a secret and a URL to come back to, and Bullpen has
 * neither: there is no server to keep a secret on and nothing listening for a
 * redirect. The device flow is the answer to exactly that - the app shows a
 * short code, the person types it into github.com in their own browser, and the
 * app polls until GitHub says yes.
 *
 * What it does need is a client id. That is not a secret - it ships inside
 * every desktop app that has ever done this - but it does have to exist, which
 * means one OAuth App registered once, with "Enable Device Flow" ticked. Until
 * there is one, `CLIENT_ID` is empty and the button says so rather than
 * pretending it could work.
 */

/**
 * Bullpen's own OAuth App: the one thing that has to be filled in for the
 * sign-in button to do anything.
 *
 * Register an OAuth App at github.com/settings/developers, tick "Enable Device
 * Flow" on it, and put its client id here. No secret and no callback URL - the
 * device flow uses neither, which is why a desktop app can use it at all. The
 * client id is not a secret either; it ships inside every desktop app that does
 * this.
 */
export const CLIENT_ID = "Ov23liEBWcKuNZcYekcH";

const DEVICE = "https://github.com/login/device/code";
const TOKEN = "https://github.com/login/oauth/access_token";
/** The one scope: read and write this account's own gists, and nothing else. */
const SCOPE = "gist";

export type DeviceCode = {
  /** What the person types into github.com. */
  userCode: string;
  /** Where they type it. */
  url: string;
  /** What this app polls with. Not shown to anybody. */
  deviceCode: string;
  /** Seconds GitHub asks to be left alone between polls. */
  interval: number;
  /** Seconds until the code stops working. */
  expires: number;
};

const post = async (
  url: string,
  body: Record<string, string>,
): Promise<Record<string, unknown>> => {
  const res = await fetch(url, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return (await res.json()) as Record<string, unknown>;
};

/** Ask GitHub for a code to show. */
export async function deviceCode(
  clientId: string,
): Promise<{ code?: DeviceCode; error?: string }> {
  if (!clientId) return { error: "No GitHub app to sign in through yet." };
  try {
    const b = await post(DEVICE, { client_id: clientId, scope: SCOPE });
    if (typeof b.device_code !== "string" || typeof b.user_code !== "string") {
      return {
        error: String(
          b.error_description ?? b.error ?? "GitHub did not send a code.",
        ),
      };
    }
    return {
      code: {
        userCode: b.user_code,
        url:
          typeof b.verification_uri === "string"
            ? b.verification_uri
            : "https://github.com/login/device",
        deviceCode: b.device_code,
        // GitHub's own floor is 5s; anything faster is answered with slow_down.
        interval: Math.max(5, Number(b.interval) || 5),
        expires: Number(b.expires_in) || 900,
      },
    };
  } catch (err) {
    return {
      error: `Could not reach GitHub: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

const wait = (ms: number): Promise<void> =>
  new Promise((done) => setTimeout(done, ms));

/**
 * Poll until the person has said yes, or until the code dies.
 *
 * `slow_down` is not a failure and neither is `authorization_pending`: the
 * first is GitHub asking for a longer gap and the second is somebody still
 * reading their screen. Treating either as an error is how a sign-in fails
 * while it is working.
 */
export async function awaitToken(
  clientId: string,
  code: DeviceCode,
): Promise<{ token?: string; error?: string }> {
  let gap = code.interval;
  const until = Date.now() + code.expires * 1000;
  while (Date.now() < until) {
    await wait(gap * 1000);
    let b: Record<string, unknown>;
    try {
      b = await post(TOKEN, {
        client_id: clientId,
        device_code: code.deviceCode,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      });
    } catch (err) {
      return {
        error: `Could not reach GitHub: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    if (typeof b.access_token === "string") return { token: b.access_token };
    const said = String(b.error ?? "");
    if (said === "authorization_pending") continue;
    if (said === "slow_down") {
      gap = Math.max(gap + 5, Number(b.interval) || gap + 5);
      continue;
    }
    if (said === "expired_token")
      return { error: "That code ran out. Start again." };
    if (said === "access_denied") return { error: "Refused on GitHub." };
    return {
      error: String(b.error_description ?? said ?? "GitHub would not say why."),
    };
  }
  return { error: "That code ran out. Start again." };
}
