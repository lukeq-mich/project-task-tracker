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
- **GitHub sync** — repository + fine-grained token (Contents: read/write, this repo only). With a token set, **every change (projects, tasks, users) is automatically committed back to `data/data.json`** in the repository — this is how new projects and tasks are written into the data folder and shared with everyone — and cover images are committed to `cover-images/`. Commits are debounced so rapid edits become one commit. The token lives in the browser's local storage — use minimal scope and revoke when unsure.
- **Reset local data** — clears this browser's local changes and reloads the current `data/data.json` from the repository.

## Where data lives — important limitation

This is a **static site with no backend**. Accounts, sign-ins, promotions, and edits are stored in the **browser's `localStorage`**, seeded from `data/data.json` on first load:

- Without a GitHub token, changes persist **on that browser/device only**. With a token configured in Settings (typically the admin's browser), all changes are committed to `data/data.json` in the repository and become the shared seed everyone else loads. Changes made in browsers *without* a token remain local to them.
- Client-side checks (the Google domain restriction) are honest gates for a personal/demo tracker, **not** production security.
- For genuinely shared, private, multi-user data, a backend (e.g. a hosted database with real auth) is required — see the repository issues/discussion for the data-privacy plan.

## Editing seed content

Edit `data/data.json` and push to `main`; the deploy workflow republishes automatically. A browser with existing local data keeps using it until **Reset demo data** is used (or site data is cleared), which re-seeds from the updated file.

---

Built with plain HTML, CSS, and JavaScript.
