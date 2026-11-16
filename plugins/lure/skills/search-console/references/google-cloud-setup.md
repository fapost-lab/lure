# Google Cloud setup, once per person

One OAuth client serves every product and every Google account of the person. It lives in their
own Google Cloud project; nothing about it is shared with Lure or anyone else. It costs nothing.

Use a personal Google account for the project unless the person prefers their organisation's;
signing in to Search Console later can use any account.

1. Open https://console.cloud.google.com/projectcreate — name the project, for example
   `lure`, and create it. Make sure it is the selected project (top bar).
2. Open https://console.cloud.google.com/apis/library/searchconsole.googleapis.com and click
   **Enable**.
3. Open https://console.cloud.google.com/auth/overview and click **Get started**:
   - App name `Lure`, support e-mail their own;
   - Audience **External**;
   - contact e-mail their own; agree and **Create**.
4. Open **Audience** (https://console.cloud.google.com/auth/audience) and click
   **Publish app**, then confirm. **This matters:** an app left in "Testing" signs the person out
   every 7 days, and scheduled checks would stop. Published but unverified is fine for one
   person: Google only shows a warning at sign-in.
5. Open **Clients** (https://console.cloud.google.com/auth/clients) → **Create client** →
   type **Desktop app**, name `Lure` → **Create** → **Download JSON**.

Google's console changes its menus from time to time; if a page looks different, the names
above (Enable the API, OAuth consent / Audience, Publish, Desktop app client) are what to look
for.

Nothing else is needed: no billing, no API key, no service account.
