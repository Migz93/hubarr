declare const __APP_VERSION__: string;

type PlexHeaders = Record<string, string>;

interface PlexPin {
  id: number;
  code: string;
}

function generateClientId(): string {
  const stored = localStorage.getItem("hubarr-plex-client-id");
  if (stored) return stored;
  const id = Array.from(crypto.getRandomValues(new Uint8Array(16)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  localStorage.setItem("hubarr-plex-client-id", id);
  return id;
}

function encodeParams(data: Record<string, string>): string {
  return Object.entries(data)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

class PlexOAuth {
  private headers?: PlexHeaders;
  private pin?: PlexPin;
  private popup?: Window;

  private initHeaders(): void {
    this.headers = {
      Accept: "application/json",
      "X-Plex-Product": "Hubarr",
      "X-Plex-Version": __APP_VERSION__,
      "X-Plex-Client-Identifier": generateClientId(),
      "X-Plex-Model": "Plex OAuth",
      "X-Plex-Platform": "Web",
      "X-Plex-Language": "en"
    };
  }

  private async getPin(): Promise<PlexPin> {
    if (!this.headers) throw new Error("Headers not initialized.");
    const response = await fetch("https://plex.tv/api/v2/pins?strong=true", {
      method: "POST",
      headers: this.headers
    });
    if (!response.ok) {
      throw new Error(`Failed to get Plex PIN: ${response.status}`);
    }
    const data = (await response.json()) as { id: number; code: string };
    this.pin = { id: data.id, code: data.code };
    return this.pin;
  }

  public preparePopup(): void {
    const w = 600;
    const h = 700;
    const leftSource = window.screenLeft ?? window.screenX;
    const topSource = window.screenTop ?? window.screenY;
    const left = leftSource + window.innerWidth / 2 - w / 2;
    const top = topSource + window.innerHeight / 2 - h / 2;
    const newWindow = window.open(
      "/login/plex/loading",
      "Plex Auth",
      `scrollbars=yes,width=${w},height=${h},top=${top},left=${left}`
    );
    if (newWindow) {
      newWindow.focus();
      this.popup = newWindow;
    }
  }

  public async login(): Promise<string> {
    if (!this.popup || this.popup.closed) {
      throw new Error("Plex login popup could not be opened. Check your browser popup settings and try again.");
    }

    // Give mobile browsers a moment to commit the user-opened same-origin tab
    // before redirecting it to the cross-origin Plex auth page.
    await wait(1500);

    this.initHeaders();
    await this.getPin();

    if (!this.headers || !this.pin) throw new Error("OAuth not initialized.");

    const params = {
      clientID: this.headers["X-Plex-Client-Identifier"],
      "context[device][product]": this.headers["X-Plex-Product"],
      "context[device][version]": this.headers["X-Plex-Version"],
      "context[device][platform]": this.headers["X-Plex-Platform"],
      "context[device][layout]": "desktop",
      code: this.pin.code,
      // Redirect back to a Hubarr-owned page so the popup can close itself
      // after Plex auth instead of relying on the opener to close a
      // cross-origin Plex tab, which mobile browsers often block.
      forwardUrl: `${window.location.origin}/login/plex/done`
    };

    if (this.popup) {
      this.popup.location.href = `https://app.plex.tv/auth/#!?${encodeParams(params)}`;
    }

    return this.pollForToken();
  }

  private async pollForToken(): Promise<string> {
    return new Promise((resolve, reject) => {
      // The user may close the popup manually before the token arrives. Allow a
      // few extra polls after detecting closure before giving up, in case the
      // Plex API response is slightly delayed.
      let gracePollsLeft = 5;

      const poll = async () => {
        try {
          if (!this.pin || !this.headers) {
            reject(new Error("PIN not initialized."));
            return;
          }

          const response = await fetch(`https://plex.tv/api/v2/pins/${this.pin.id}`, {
            headers: this.headers
          });
          const data = (await response.json()) as { authToken?: string | null };

          if (data.authToken) {
            this.popup?.close();
            this.popup = undefined;
            resolve(data.authToken);
          } else if (this.popup?.closed) {
            if (gracePollsLeft-- > 0) {
              setTimeout(poll, 1000);
            } else {
              reject(new Error("Plex login popup was closed before authorization completed."));
            }
          } else {
            setTimeout(poll, 1000);
          }
        } catch (error) {
          this.popup?.close();
          this.popup = undefined;
          reject(error);
        }
      };
      setTimeout(poll, 1000);
    });
  }
}

export default PlexOAuth;
