# Project Task Tracker

A general-purpose workspace for tracking projects and tasks across a delivery portfolio. Self-contained static site — no server and no build step. Content lives in a single JSON file, business rules live in a single workflows file, and sign-ups persist in the browser.

**Live site:** `https://lukeq-mich.github.io/project-task-tracker/`

## How it works

| File | Role |
|---|---|
| `index.html` | The whole app UI plus the login/registration gate and local persistence. Role-gated navigation. |
| `workflows.js` | All business rules: role-based access control, the sign-up policy, task-overdue detection, colour mapping, dashboard KPIs, and validation. |
| `data/data.json` | Seed content and configuration — users, projects, tasks, enums, theme, and the `auth` block (password salt + admin-code hash). |
| `.github/workflows/deploy.yml` | Deploys to GitHub Pages on every push to `main`. |
| `favicon.svg` | Browser-tab icon. |

## Accounts, sign-up, and roles

The app opens on a **Log in / Register** screen.

- **Register** creates a new account. Everyone starts as a **Member**; an admin can promote them later from the Users page.
- To register **as an Admin**, enter the **admin registration code** on the Register form. The default code is **`make-me-admin`** — change it before real use (see below).
- **Log in** with email + password.

Demo accounts are seeded so you can see each role immediately. They all share the password **`demo1234`**:

| Email | Role |
|---|---|
| avery.chen@example.com | Admin |
| grace.lin@example.com | Executive |
| bruno.diaz@example.com | Project Lead |
| dev.okoro@example.com | Member |

There are **four roles**. **Admin** and **Executive** are identical except that only Admins can manage users.

| Capability | Admin | Executive | Project Lead | Member |
|---|:-:|:-:|:-:|:-:|
| View dashboards / projects / tasks / My Tasks | ✓ | ✓ | ✓ | ✓ |
| Member contributions | ✓ | ✓ | | |
| Create / edit / delete projects | ✓ | ✓ | | |
| Create / delete + edit all task fields | ✓ | ✓ | ✓ | |
| Update own task status + completion date | | | | ✓ |
| Users admin — create / edit / delete + promote users | ✓ | | | |

## Changing the admin code

The admin code is stored only as a SHA-256 hash in `data/data.json` (`auth.adminCodeHash`), so the plain code is not in the repo. To set your own code, compute its hash and paste it in:

```bash
# replace YOUR-NEW-CODE
printf '%s' 'YOUR-NEW-CODE' | shasum -a 256
```

Put the resulting hex string in `auth.adminCodeHash`, commit, and push. Anyone who knows the new code can then self-register as an Admin.

## Important limitation — where data lives

This is a **static site with no backend**. Accounts, sign-ups, promotions, and edits are stored in the **browser's `localStorage`**, seeded from `data/data.json` on first load. That means:

- Changes persist across refreshes **on that browser/device only** — they are **not** shared between users or devices.
- Passwords are hashed client-side (SHA-256). This is **not** production-grade auth — treat it as a lightweight gate for a personal/demo tracker, not real security.
- The **Reset demo data** button (Users page, admin only) clears local data and re-seeds from `data.json`.

For genuine multi-user, shared, secure accounts you need a backend — e.g. a hosted auth/database service (Supabase, Firebase) or a small API. That's the natural next step if you outgrow the local version.

## Editing seed content

Edit `data/data.json` and push to `main`; the deploy workflow republishes automatically. Note that a browser which already has local data will keep using it until you hit **Reset demo data** (or clear site data), which re-seeds from the updated file.

---

Built with plain HTML, CSS, and JavaScript. Dark "Midnight" theme.
