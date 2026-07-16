# Project Task Tracker

A general-purpose workspace for tracking projects and tasks across a delivery portfolio. Self-contained static site — no server and no build step. Content lives in a single JSON file, business rules live in a single workflows file, and per-browser changes persist locally.

**Live site:** [https://lukeq-mich.github.io/project-task-tracker/](https://lukeq-mich.github.io/project-task-tracker/)

## How it works

| File | Role |
|---|---|
| `index.html` | The whole app UI — sign-in gate, dashboard, projects (card + list views), tasks, My Tasks, member contributions, users admin, and the admin Settings page. |
| `workflows.js` | All business rules: role-based access control, role-scoped upcoming tasks, one-lead-per-project and one-membership-per-user rules, overdue detection, colour mapping, KPIs, and validation. |
| `data/data.json` | Seed content and configuration — users, projects, tasks, enums, theme, and the `auth` block (Google client ID, allowed domain, admin emails, password salt for demo accounts). |
| `cover-images/` | Project cover images uploaded through the app (when a GitHub token is configured in Settings). |
| `.github/workflows/deploy.yml` | Deploys to GitHub Pages on every push to `main`. |

## Signing in

The app opens on a sign-in screen. **Sign in with Google is the only way to sign in or register** — password login has been removed entirely.

- Sign-in is restricted to verified **@umich.edu** Google accounts. First sign-in automatically registers the account as a **Member**; an admin can promote it afterwards.
- If the signing email is listed in `auth.adminEmails` in `data/data.json`, the account is created as an **Admin** — this is the reliable way to register yourself as an admin.
- The seeded demo users are directory entries only; they cannot sign in.
- **Delete my account** — available in the sidebar. Deleting your account unassigns your tasks, removes you as a project lead, frees your project-membership slot, and removes the account (on that browser's data). The only remaining Admin cannot self-delete — promote another Admin first, so the site is never left without admin access.

## Roles

Four roles. **Admin** and **Executive** are identical except that only Admins manage users and site settings.

| Capability | Admin | Executive | Project Lead | Member |
|---|:-:|:-:|:-:|:-:|
| View dashboards / projects / tasks / My Tasks | ✓ | ✓ | ✓ | ✓ |
| Member contributions | ✓ | ✓ | | |
| Create / edit / delete projects, manage project members | ✓ | ✓ | | |
| Create / delete + edit all task fields | ✓ | ✓ | ✓ | |
| Update own task status + completion date | | | | ✓ |
| Users admin (create / edit / delete / promote users) | ✓ | | | |
| Settings (logo, theme, integrations) | ✓ | | | |

**View as role (admins only):** the sidebar has a "View as role" selector letting an admin preview the site as an Executive, Project Lead, or Member. It's a local, per-browser view override — your real role stays Admin, nothing is saved or synced, and a banner plus a "Back to Admin" link keep it obvious you're previewing. It only ever previews *lower* roles (it can never elevate anyone), and the destructive "Delete my account" action is hidden while previewing.

**Role-scoped dashboard:** the "Upcoming tasks" panel shows Members only their own assigned tasks, Project Leads the tasks in projects they lead, and Admins/Executives tasks across all projects.

## Projects

- **Card and list views** — cards show the project's cover image; the list view intentionally does not.
- **Cover images** — upload from the project form. With a GitHub token configured in Settings, the image is committed to the repo's `cover-images/` folder (shared with everyone via the site); without one it's stored in the browser only.
- **Names sort alphabetically** everywhere they're listed — the users table, lead/assignee dropdowns, member pickers and chips, and contributions.
- **Date fields open a calendar picker** on click (native date picker, opened programmatically for one-click access).
- **Info URL** — each project can link out to an external info page (e.g. a Google Drive folder), shown on the project detail page.
- **Task progress** is shown as counts (e.g. `3/8 done`) rather than a percentage, since task lists grow over time.
- **One lead per project-lead** — assigning a lead who already leads another project prompts for confirmation and unassigns them from the previous project.
- **Members** — each user holds exactly one project-membership slot (an admin's or executive's oversight role is separate from their slot). The project page has a batch **Add members** dialog; selecting people already on another project prompts for confirmation before moving them.
- **Deleting a project** cascades: all its tasks are deleted and every member's project association resets to none.

## Tasks

- A task is **overdue** when its due date is past and it isn't Completed.
- **My Tasks** supports filtering by status/priority and **sorting by due date** (click the Due column header to toggle ascending/descending).

## Admin Settings

Admins get a **Settings** page:

- **Logo & favicon** — upload a custom image used as the site logo (upper left) and browser favicon.
- **Theme colours** — customize the full palette (primary, accent, background, surfaces, borders, text), with one-click reset to the default theme.
- **Shared sync (Cloudflare Worker)** — a Worker URL, not a raw token. With it set, **every signed-in user's changes** — projects, tasks, users, cover images — are committed to the repository (`data/data.json` and `cover-images/`), not just one browser's local copy. See "Shared sync via Cloudflare Worker" below for what this is and how to deploy it.
- **Reset local data** — clears this browser's local changes and reloads the current `data/data.json` from the repository.

## Where data lives

By default this is a **static site with no backend**: accounts, sign-ins, promotions, and edits are stored in the **browser's `localStorage`**, seeded from `data/data.json` on first load, and don't leave that browser/device.

**Shared sync via Cloudflare Worker** closes that gap without a full backend rebuild. A small Worker (deployed once, free tier) sits between the app and GitHub:

- The site already signs everyone in with Google. When a signed-in user saves something, the app sends their **Google ID token** to the Worker along with the change.
- The Worker **independently re-verifies that ID token** against Google's public keys — checking it's genuine, unexpired, verified, and on the `@umich.edu` domain — before writing anything.
- Only then does the Worker commit to `data/data.json` (or `cover-images/`) using a GitHub token that is configured **only inside the Worker** and is never sent to any browser.

This means every signed-in user's edits reach the repository, while the GitHub credential itself stays server-side and out of reach of anyone inspecting the page or its network traffic. It's a genuine, verified write path — not "paste a shared secret into the app."

### Deploying the Worker

The Worker source is in [`worker/worker.js`](worker/worker.js).

1. Create a free account at [dash.cloudflare.com](https://dash.cloudflare.com) (Cloudflare Workers, not Pages).
2. **Workers & Pages → Create → Create Worker.** Give it a name (e.g. `project-task-tracker-sync`), click **Deploy** to scaffold it.
3. Click **Edit code**, delete the placeholder content, and paste in the contents of `worker/worker.js`. Click **Deploy**.
4. Go to the Worker's **Settings → Variables and Secrets** and add:
   - `GITHUB_TOKEN` (secret) — a fine-grained GitHub PAT, **Contents: Read and write**, scoped to this repository only.
   - `GITHUB_REPO` — `lukeq-mich/project-task-tracker`
   - `GOOGLE_CLIENT_ID` — the same client ID used in `auth.googleClientId`
   - `ALLOWED_DOMAIN` — `umich.edu`
   - `ALLOWED_ORIGIN` — `https://lukeq-mich.github.io`
5. Copy the Worker's URL (shown at the top of its page, formatted like `https://project-task-tracker-sync.<your-subdomain>.workers.dev`).
6. On the site, sign in as an Admin → **Settings** → **Shared sync** → paste the Worker URL → **Save**.

Once set, every signed-in user's create/edit/delete actions sync to the repository automatically (debounced so rapid edits become one commit). Anyone without network access to a configured Worker URL — or whose Google token fails verification — simply can't write to the repo; their session still works locally.

**A note on session length:** the Google ID token that authorizes each sync is short-lived (about an hour) and is kept in the browser's `sessionStorage`, so it survives page reloads within the same tab/session but not a fresh browser tab or a token past its expiry. If a sync shows "sign in with Google again" in Settings, that's expected — logging out and back in refreshes it. Local saving always still works even when a sync is skipped or fails; only the repository write is affected.

If the Worker URL isn't set, the app falls back to the local-only behavior described above.

## Editing seed content

Edit `data/data.json` and push to `main`; the deploy workflow republishes automatically. A browser with existing local data keeps using it until **Reset demo data** is used (or site data is cleared), which re-seeds from the updated file.

---

Built with plain HTML, CSS, and JavaScript.
