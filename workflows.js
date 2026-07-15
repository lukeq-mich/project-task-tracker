/*
 * workflows.js
 * ---------------------------------------------------------------------------
 * All business rules and workflows for Project Tracker live here, kept
 * separate from the UI (index.html) and the data (data/data.json).
 *
 *   - Role-based access control (Admin / Executive / Project Lead / Member / Viewer)
 *   - Task overdue detection and priority/status colour mapping
 *   - Dashboard KPI + project-lead coverage computation
 *
 * Roles:
 *   Admin        - full access, including creating/editing/deleting users.
 *   Executive    - identical to Admin EXCEPT cannot manage users.
 *   Project Lead - create/edit/delete tasks in projects; no project or user admin.
 *   Member       - update the status/completion of tasks assigned to them;
 *                  the default role for anyone who signs up.
 *
 * Exposed on window.Workflows so index.html can call it with no build step.
 */
(function () {
  'use strict';

  // ---- Role keys -----------------------------------------------------------
  const ROLE = {
    ADMIN: 'RoleKey0',
    EXEC: 'RoleKey1',
    LEAD: 'RoleKey2',
    MEMBER: 'RoleKey3',
  };

  const isAdmin       = (roleKey) => roleKey === ROLE.ADMIN;
  const isExecutive   = (roleKey) => roleKey === ROLE.EXEC;
  const isProjectLead = (roleKey) => roleKey === ROLE.LEAD;
  const isMember      = (roleKey) => roleKey === ROLE.MEMBER;

  // Admins and Executives share the same permissions except user management.
  const isAdminOrExec = (roleKey) => isAdmin(roleKey) || isExecutive(roleKey);
  const hasAppAccess  = (roleKey) =>
    isAdmin(roleKey) || isExecutive(roleKey) || isProjectLead(roleKey) || isMember(roleKey);

  // ---- Sign-up policy ------------------------------------------------------
  // Everyone who registers starts as a Member; an admin can promote them later.
  const signupRole = () => ROLE.MEMBER;

  function validateSignup({ name, email, password }) {
    const errs = [];
    if (!name || !name.trim()) errs.push('Name is required.');
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim())) errs.push('A valid email is required.');
    if (!password || password.length < 6) errs.push('Password must be at least 6 characters.');
    return errs;
  }

  // ---- Page visibility -----------------------------------------------------
  const canViewDashboard           = (r) => hasAppAccess(r);
  const canViewProjectList         = (r) => hasAppAccess(r);
  const canViewProjectDetail       = (r) => hasAppAccess(r);
  const canViewTaskDetail          = (r) => hasAppAccess(r);
  const canViewMyTasks             = (r) => hasAppAccess(r);
  const canViewMemberContributions = (r) => isAdminOrExec(r);
  const canViewUsersAdmin          = (r) => isAdmin(r); // admins only

  // ---- Record-level permissions -------------------------------------------
  const canCreateProject = (r) => isAdminOrExec(r);
  const canEditProject   = (r) => isAdminOrExec(r);
  const canDeleteProject = (r) => isAdminOrExec(r);

  const canCreateTask = (r) => isAdminOrExec(r) || isProjectLead(r);
  const canDeleteTask = (r) => isAdminOrExec(r) || isProjectLead(r);

  // Admins/Execs/Leads may edit all fields; members may edit only their own task fields.
  const canUpdateTaskCoreFields   = (r) => isAdminOrExec(r) || isProjectLead(r);
  const canUpdateTaskMemberFields = (r) => isMember(r);
  const canEditTask = (r) => canUpdateTaskCoreFields(r) || canUpdateTaskMemberFields(r);

  // User management is admin-only (executives cannot create/edit/delete users).
  const canManageUsers = (r) => isAdmin(r);

  // Who can be assigned as a project lead.
  const canBeProjectLead = (r) => isAdminOrExec(r) || isProjectLead(r);

  // ---- Identity matching (My Tasks) ---------------------------------------
  const norm = (v) => (v == null ? '' : String(v).trim().toLowerCase());

  function resolveDirectoryUser(users, identity) {
    if (!identity) return undefined;
    const email = norm(identity.email);
    const name = norm(identity.title || identity.name);
    return (
      users.find((u) => email && norm(u.email) === email) ||
      users.find((u) => name && norm(u.title) === name)
    );
  }

  function tasksForUser(tasks, user) {
    if (!user) return [];
    return tasks.filter((t) => t.assignedTo && t.assignedTo.id === user.id);
  }

  // ---- Task state ----------------------------------------------------------
  function parseDateOnly(value) {
    if (!value) return null;
    const parts = String(value).split('-').map(Number);
    if (parts.length !== 3 || parts.some(isNaN)) return null;
    return new Date(parts[0], parts[1] - 1, parts[2]);
  }

  function isTaskOverdue(task) {
    if (!task.dueDate || task.statusKey === 'StatusKey2') return false;
    const due = parseDateOnly(task.dueDate);
    if (!due) return false;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return due < today;
  }

  const PRIORITY_COLOR = {
    PriorityKey0: '#3f7d5a',
    PriorityKey1: '#b8862b',
    PriorityKey2: '#c2701c',
    PriorityKey3: '#b23b3b',
  };
  const STATUS_COLOR = {
    StatusKey0: '#5b6675',
    StatusKey1: '#b8862b',
    StatusKey2: '#3f7d5a',
  };
  const priorityColor = (k) => PRIORITY_COLOR[k] || '#5b6675';
  const statusColor   = (k) => STATUS_COLOR[k] || '#5b6675';

  // ---- Dashboard aggregation ----------------------------------------------
  function dashboardKpis(data) {
    const { projects, tasks } = data;
    const openTasks = tasks.filter((t) => t.statusKey !== 'StatusKey2');
    return {
      totalProjects: projects.length,
      activeProjects: projects.filter((p) => p.statusKey === 'StatusKey1').length,
      completedProjects: projects.filter((p) => p.statusKey === 'StatusKey2').length,
      totalTasks: tasks.length,
      openTasks: openTasks.length,
      overdueTasks: tasks.filter(isTaskOverdue).length,
    };
  }

  function projectLeadCoverage(data) {
    const map = new Map();
    data.projects.forEach((p) => {
      if (!p.projectLead) return;
      const entry = map.get(p.projectLead.id) || { lead: p.projectLead, count: 0 };
      entry.count += 1;
      map.set(p.projectLead.id, entry);
    });
    return Array.from(map.values()).sort((a, b) => b.count - a.count);
  }

  function upcomingTasks(data, limit = 5) {
    return data.tasks
      .filter((t) => t.statusKey !== 'StatusKey2' && t.dueDate)
      .sort((a, b) => parseDateOnly(a.dueDate) - parseDateOnly(b.dueDate))
      .slice(0, limit);
  }

  function projectProgress(data, projectId) {
    const items = data.tasks.filter((t) => t.associatedProject && t.associatedProject.id === projectId);
    if (!items.length) return { done: 0, total: 0, pct: 0 };
    const done = items.filter((t) => t.statusKey === 'StatusKey2').length;
    return { done, total: items.length, pct: Math.round((done / items.length) * 100) };
  }

  // ---- Validation ----------------------------------------------------------
  function validateProject(p) {
    const errs = [];
    if (!p.title || !p.title.trim()) errs.push('Title is required.');
    if (!p.startDate) errs.push('Start date is required.');
    if (!p.statusKey) errs.push('Status is required.');
    if (p.endDate && p.startDate && p.endDate < p.startDate) errs.push('End date cannot precede start date.');
    return errs;
  }

  function validateTask(t) {
    const errs = [];
    if (!t.title || !t.title.trim()) errs.push('Title is required.');
    if (!t.associatedProject || !t.associatedProject.id) errs.push('Associated project is required.');
    if (!t.priorityKey) errs.push('Priority is required.');
    if (!t.statusKey) errs.push('Status is required.');
    return errs;
  }

  window.Workflows = {
    ROLE,
    isAdmin, isExecutive, isProjectLead, isMember, isAdminOrExec, hasAppAccess,
    signupRole, validateSignup,
    canViewDashboard, canViewProjectList, canViewProjectDetail, canViewTaskDetail,
    canViewMyTasks, canViewMemberContributions, canViewUsersAdmin,
    canCreateProject, canEditProject, canDeleteProject,
    canCreateTask, canDeleteTask, canUpdateTaskCoreFields, canUpdateTaskMemberFields,
    canEditTask, canManageUsers, canBeProjectLead,
    resolveDirectoryUser, tasksForUser,
    parseDateOnly, isTaskOverdue, priorityColor, statusColor,
    dashboardKpis, projectLeadCoverage, upcomingTasks, projectProgress,
    validateProject, validateTask,
  };
})();
