# MDT Project Manager

An internal engineering workspace for tracking projects and tasks across MDT's delivery portfolio. Rebuilt as a self-contained static site — no database, no server, no build step. All content lives in a single JSON file, and all business rules live in a single workflows file.

**Live site:** `https://lukeq-mich.github.io/project-task-tracker/`

## How it works

| File | Role |
|---|---|
| `index.html` | The whole app UI — dashboard, projects (list + kanban detail), tasks, My Tasks, member contributions, and the users admin. Role-gated navigation. |
| `workflows.js` | All business rules and workflows: role-based access control (Admin / Project Lead / Member / Viewer), task-overdue detection, priority/status colour mapping, dashboard KPI + project-lead coverage computation, and validation. |
| `data/data.json` | The single source of truth for all content — users, projects, tasks, enums, and site/theme meta. |
| `.github/workflows/deploy.yml` | Deploys the site to GitHub Pages on every push to `main`. |
| `favicon.svg` | Browser-tab icon (MDT shield). |

Separating data (`data.json`) and rules (`workflows.js`) from the interface (`index.html`) mirrors the pattern used in the companion portfolio repo.

## Content model

Records are linked by ID with denormalised titles for display, matching the original app's data model:

- **Users** — `title`, `email`, `roleKey` (Admin / Project Lead / Member / Viewer), optional `projectMembership`.
- **Projects** — `title`, `statusKey`, `startDate`, `endDate`, optional `projectLead`.
- **Tasks** — `title`, `associatedProject`, optional `assignedTo`, `statusKey`, `priorityKey`, `dueDate`, `completionDate`, `taskDetailsInstructions`.

## Roles & permissions (defined in `workflows.js`)

| Capability | Admin | Project Lead | Member | Viewer |
|---|:---:|:---:|:---:|:---:|
| View dashboard / projects / tasks / My Tasks | ✓ | ✓ | ✓ | ✓ |
| Create / edit / delete projects | ✓ | | | |
| Create / delete tasks | ✓ | ✓ | | |
| Edit all task fields | ✓ | ✓ | | |
| Update own task status + completion date | | | ✓ | |
| Member contributions & Users admin | ✓ | | | |

Use the **Signed in as** selector in the sidebar to switch between users and see how the interface changes per role.

## Task rules

- A task is **overdue** when its due date is in the past and it is not marked Completed.
- Priority and status badges are colour-mapped (Low → green, Medium → amber, High → orange, Critical → red).
- **My Tasks** resolves the signed-in user against the Users list (primarily by email) and shows their assigned tasks.

## Editing content

The seeded data in `data/data.json` is sample data. Edit that file directly (or through your own tooling) and push to `main` — the deploy workflow republishes the site automatically. In-app create/edit/delete actions update the in-memory copy for the current session; persisting them back to `data.json` (e.g. via a GitHub-API editor like the portfolio's `admin.html`) is a natural next phase.

---

Built with plain HTML, CSS, and JavaScript. Dark "Military night" theme (black, steel grey, command blue).
