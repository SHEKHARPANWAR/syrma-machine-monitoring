# Syrma SGS – Machine Breakdown Monitoring System (v2)

A plain **HTML + CSS + JS** version of this app (no build step, no Node, no React) —
ready to drop straight into a GitHub repo and serve with **GitHub Pages**.

This version adds: mandatory login (Supabase Auth), role-based access
(Admin / Supervisor / Operator), a password-change request workflow, a full
audit trail, machine master fields (Serial No, Install Date), and multi-user
safe cloud sync. No existing functionality (MTTR/MTBF engine, QR scanning,
dashboards, charts, exports) was removed — only the "Reset All Data" and
"Load Sample Data" buttons, as requested.

## Files

```
index.html              ← markup + script tags for libraries (Chart.js, jsQR, xlsx, qrcode, Supabase)
style.css               ← all styling (glassmorphism UI, themes, responsive layout, login screen)
script.js               ← all app logic (auth, MTTR/MTBF engine, QR scanning, charts, Supabase sync, audit log)
supabase-schema.sql     ← run once in Supabase SQL Editor — creates/updates all tables (safe to re-run)
```

Everything runs directly in the browser. There is nothing to `npm install` or build.

## One-time setup (in order)

### 1. Run the database schema
Open your Supabase project's **SQL Editor** and run the entire contents of
`supabase-schema.sql`. It is safe to run multiple times — every statement
guards against re-creating or duplicating existing objects, so it will
never delete your data.

This creates:

| Table                       | Purpose                                                  |
|------------------------------|-----------------------------------------------------------|
| `machines`                  | One row per machine (master data + status + ownership)   |
| `breakdown_events`          | One row per failure → repair cycle                        |
| `master_list_items`         | Dropdown values for Area / Line / Customer                |
| `profiles`                  | Role (admin/supervisor/operator) for each login           |
| `audit_logs`                | Full activity trail (who did what, when, from what device)|
| `password_change_requests`  | ID/password change requests awaiting admin review          |

### 2. Create the default admin login
Supabase Auth manages password hashing itself — it can't be done from a
plain SQL `insert` statement. Creating the very first login is a one-time
manual step:

1. Supabase Dashboard → **Authentication → Users → Add user**
2. Email: `shekharpanwar@syrmasgs.local` (any unique email-shaped string works — there's no real mailbox involved)
3. Password: `Syrma@123`
4. Tick **Auto Confirm User** → Create
5. Back in the SQL Editor, run the commented block at the bottom of
   `supabase-schema.sql` (uncomment it first) to attach the **admin** role
   to that account. It looks the user up by email automatically.

After that, sign in to the app with:
- **User ID:** `Shekharpanwar`
- **Password:** `Syrma@123`

### 3. Add more users (Supervisor / Operator)
Repeat step 2 for each new person (Dashboard → Authentication → Add user),
then either:
- Let them log in once — the app auto-creates a basic "operator" profile row, or
- Insert/update their `public.profiles` row yourself to set `role` to
  `'admin'`, `'supervisor'`, or `'operator'` and set their display `user_id`.

There is intentionally no public self-service "Sign Up" page — new accounts
are created by an administrator via the Supabase dashboard, consistent with
this being an internal factory tool with role-gated access.

## Deploy on GitHub Pages

1. Push `index.html`, `style.css`, `script.js` to your repo's root (or a `docs/` folder).
2. Repo → **Settings → Pages** → **Build and deployment → Source** → **Deploy from a branch**.
3. Pick the branch and folder, then **Save**.
4. GitHub gives you a live URL: `https://<your-username>.github.io/<repo-name>/`
5. Open it — login, dashboard, QR scanner (HTTPS required, provided automatically by GitHub Pages), charts, and Supabase cloud sync all work as-is.

## What's new in v2

- **Mandatory login** — nothing in the app is visible or usable until signing in.
- **Sessions persist** — closing the browser and coming back later keeps you signed in until you explicitly log out.
- **Roles** — Admin, Supervisor, Operator (`public.profiles.role`). Admins get two extra sidebar sections: **Requests** and **Audit Log**. Role checks beyond menu visibility (e.g. restricting *write* actions to certain roles) can be added in `public.profiles`-aware RLS policies if you want to tighten this further — by default any signed-in user can read/write operational data, which matches "multi-user, centralized database" in the requirements.
- **Password change requests** — a "Request ID / Password Change" button on the login screen opens a form (current ID, name, email, reason, optional new ID). Submissions are saved to `password_change_requests` for an admin to review under the **Requests** tab. There is no outgoing-email server here, so the in-app Requests list is the system of record — resolving a request there does not by itself change anyone's password; use the Supabase dashboard for the actual credential change, then mark the request resolved.
- **Audit trail** — every login, logout, machine add/edit/delete, breakdown open/close, master-data change, and password-change request is written to `audit_logs` with username, timestamp, and device info (`navigator.userAgent`). Visible to admins under **Audit Log**.
- **Machine master fields** — Serial Number and Installation Date added alongside the existing Area/Line/Customer/Machine/Asset Number/Status/QR fields. The Machines view now has an **Edit** button and Area/Line/Customer/Status filter dropdowns.
- **Duplicate prevention** — adding a machine now checks Asset Number and Serial Number for clashes (not just Asset Number), and blocks an exact name+area+line duplicate when neither identifier is provided.
- **"Reset All Data" and "Load Sample Data" removed** — permanently deleted from the UI and the code, as requested.
- **Safer multi-user sync** — the previous sync logic deleted any cloud row that was "missing" from the current browser's local copy, which could wipe out another signed-in user's just-added machine if their two browsers' local caches were briefly out of sync. Deletes are now only ever explicit (you click Delete), never inferred.

## Cloud data (Supabase)

Connection details are already set inside `script.js`
(`SUPABASE_URL` / `SUPABASE_KEY` near the top of the Supabase section). The
Supabase **publishable** key is safe to ship in client-side code — access
control is enforced by the Row Level Security policies in the schema
(every table requires a signed-in Supabase Auth user; `audit_logs` and
`password_change_requests` are further restricted to admin-only reads).

If Supabase is ever unreachable, the app falls back to a local browser
cache so the UI doesn't go blank — but write actions (adding a machine,
recording a failure/repair) need connectivity to actually save to the
shared database, since this is now a real multi-user system rather than a
single-browser local-storage app.

## Notes

- QR camera scanning requires the page to be served over **HTTPS** — GitHub Pages does this by default.
- No `.env`, no API keys to manage at build time.
