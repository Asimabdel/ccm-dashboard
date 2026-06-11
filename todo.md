# CCM Dashboard — Rebuild TODO (accurate)

## Schema & Data
- [x] Add `priorityLevel` (high/medium/low) to ccmTasks and patients
- [x] Create all 11 tables in database (fixed missing tables bug)
- [x] Add clinicLocation/languagesSpoken to users; expand role enum
- [x] Seed clinics (3)
- [x] Seed providers (5)
- [x] Seed demo users for each role (8)
- [x] Seed 40+ realistic patients (45)
- [x] Seed current-month ccmTasks with varied statuses & priorities (39)
- [x] Seed ccmNotes, escalations, follow-ups, billing records, notifications
- [x] Idempotent admin-only seed endpoint callable from UI

## Backend (tRPC)
- [x] auth.setRole — switch own role for testing
- [x] worklist.generate — auto-create tasks for active patients
- [x] worklist.forMonth with filters (status, priority, staff, clinic, provider)
- [x] worklist.bulkUpdateStatus / updateStatus / updatePriority / updateTime
- [x] worklist.assign (single + bulk) and autoBalance (rule-based)
- [x] staff.workload
- [x] ccmNotesAI.generateNote — LLM note from structured responses
- [x] ccmNotes.save — note + task + escalation + follow-ups + billing
- [x] escalations.list / updateStatus (provider review)
- [x] billing.list (readiness) + markBilled + recompute
- [x] followUps.list / create / updateStatus
- [x] notifications.list / unread / markRead
- [x] admin stats / staffPerformance / clinicPerformance / dailyTrend
- [x] reports.summary

## Frontend
- [x] Role switcher UI (demo) in layout
- [x] Patient Database: list, search/filter, enroll form, detail view w/ history
- [x] Monthly Worklist: filters, priority badges, status updates, bulk actions
- [x] Guided Call Workflow: script, structured form, timer + manual, LLM note, escalation
- [x] Admin Dashboard live
- [x] Staff worklist (staff role home) live
- [x] Provider Escalations dashboard live
- [x] Billing Dashboard live (readiness checklist + mark billed)
- [x] Front Desk Follow-ups dashboard live
- [x] Reporting Dashboard
- [x] Notifications dropdown live

## Quality
- [x] Exact status & priority label wording (vitest verified)
- [x] Role access strictly separated (vitest verified)
- [x] Fixed Tailwind v4 CSS bug (was using v3 @tailwind directives → no utilities)
- [x] Scandinavian design consistent (Inter + Syne fonts, pastel accents)
- [x] Vitest tests pass (labels + RBAC, 11 tests)
- [x] TypeScript passes (0 errors), dev server healthy
- [x] Fixed OAuth login (clinicLocation/languagesSpoken columns present in DB)

## Enhancement: Bulk import, RPM, duplicates, HIPAA, worker logins
- [x] Add RPM fields to patients (rpmEnrolled, rpmDeviceType, rpmStatus)
- [x] RPM enrollment control next to each patient in Patient Database (inline popover)
- [x] Bulk patient import (paste CSV / upload CSV) with preview + commit
- [x] Duplicate-name detection: flag patients sharing the same name (+ sameDob signal)
- [x] Surface duplicate flags in bulk import preview AND patient list
- [x] Keep Manus OAuth for worker logins; roles assigned per worker via DB/role switcher
- [x] HIPAA: audit log table + record reads/writes of PHI (list/view/create/update/import/rpm)
- [x] HIPAA: audit log viewer (admin only) at /audit
- [x] HIPAA: idle session timeout with auto-logout + 60s warning modal
- [x] HIPAA: RBAC reinforcement (import limited to admin/front_desk; audit admin-only)
- [x] Vitest: bulk import parsing + validation + duplicate detection (8 tests)

## RBAC hardening (HIPAA access control)
- [x] Make `auth.setRole` admin-only (no self-escalation by regular workers)
- [x] Add admin-managed `users.list` + `users.setRole` procedures (self-demotion guard)
- [x] Add Admin "Team / Access" page (/team) to assign roles per worker
- [x] Bootstrap: project owner (OWNER_OPEN_ID) auto-promoted to admin on upsert
- [x] Vitest: non-admin cannot self-escalate; cannot reach users/audit/import (24 tests pass)

## Round 3: Modernize UI, invites, providers/clinics CRUD, remove timers
- [x] Schema: teamInvites table (email, role, clinicLocation, status, invitedBy, timestamps)
- [x] Backend: invites.send (admin) — pre-assign role by email
- [x] Backend: invites.list / invites.revoke (admin)
- [x] Backend: on user upsert, auto-apply pending invite role + clinic by email
- [x] Backend: users.remove — remove team member (self-removal lockout guard)
- [x] Backend: providers CRUD (list/create/update/remove, admin, reassign guard)
- [x] Backend: clinics CRUD (list/create/update/remove, admin, reassign guard)
- [x] Remove call-duration timer + manual time entry from Call Workflow
- [x] Remove time/minutes tracking from billing + stats + seed (backend + UI)
- [x] Frontend: Team & Access page — invite form + pending invites + remove member
- [x] Frontend: Providers management page (add/edit/remove)
- [x] Frontend: Clinics management page (add/edit/remove)
- [x] UI modernization pass (soft shadows, gradient accents, motion, sticky header)
- [x] Vitest: invites/team/clinic/provider access control + lockout guards (32 tests pass)

## Round 4: Readability, real-template bulk import, email invites, reporting, AI timestamp, table columns
- [x] Readability: fix transparent/low-contrast sections, boxes, dropdowns (global form CSS)
- [x] Readability: inputs/textarea/select solid white + dark text; placeholders visible
- [x] Bulk import: auto-detect Template A (Dr.Mai CCMs) and Template B (Chart Notes Report)
- [x] Bulk import: parse "Last, First" names; M/D and MM/DD/YYYY dates; phone optional
- [x] Bulk import: capture provider, last called, next appointment, completion status
- [x] Schema: add lastCalledAt + nextAppointment + completedAt/completedByStaffId + aiGeneratedAt
- [x] Email invites: deliver via Resend on invites.send (key validated live), copy-link fallback
- [x] Generate with AI: store + display timestamp when worker clicks Generate
- [x] Reporting: completions per day
- [x] Reporting: completions per provider
- [x] Reporting: completions per employee (staff)
- [x] Reporting: combination reports (any mix of date/week/provider/employee/clinic)
- [x] Reporting: per clinic completions per week + CSV export
- [x] Patient table: remove Risk column (+ removed Risk filter, relabeled to Priority)
- [x] Patient table: add Last Called column (auto-updates on contact)
- [x] Patient table: add Next Appointment column
- [x] Vitest: template detection + parsing + duplicate flagging + Resend key (34 tests pass)

## Round 5: Fix invites DB error, login creation, remove billing readiness, editable dates, readability
- [x] Diagnose & fix `teamInvites` insert failure ("Failed query") — root cause: teamInvites table never migrated to live DB; removed dependency entirely
- [x] Replace email invites with admin-created worker logins (members.create + upsertUser links pending email rows on first sign-in)
- [x] Remove "Ready for Billing" stat from Billing page and Admin dashboard
- [x] Allow editing + manual date input for "Last CCM Call" (lastCalledAt) — inline on table + detail page
- [x] Allow editing + manual date input for "Next Appointment" (nextAppointment) — inline on table + detail page
- [x] Improve readability: headings switched Syne→Inter, darker muted text, body weight/size
- [x] Verify bulk import accepts the two real templates (Dr.Mai 388 rows, Chart Notes 115 rows; no phonenumber error)
- [x] Thorough review of every page/flow; all 18 routes map to imported pages, auth/RBAC redirects work
- [x] Ensure all tests pass (34) and TypeScript clean (0 errors)

## Round 6: Email + password login (alongside Manus OAuth)
- [x] Schema: add passwordHash, passwordSetAt, mustChangePassword to users (applied to live DB)
- [x] Backend: bcryptjs installed; password helpers (getUserByEmail, setUserPassword) added; createMember accepts passwordHash
- [x] Backend: createMember sets hash + mustChangePassword + local: openId for immediate sign-in
- [x] Backend: auth.passwordLogin (email+password) issues same JWT session cookie via sdk.createSessionToken
- [x] Backend: auth.changePassword (self; requires current pw unless mustChangePassword) clears flag
- [x] Backend: users.resetPassword (admin sets new temp password, forces change)
- [x] Frontend: password login form on Home (email + password) alongside Manus sign-in
- [x] Frontend: first-login forced change-password screen (/change-password?forced=1)
- [x] Frontend: Team & Access — temporary password on create + Set/reset password action per member
- [x] Vitest: password helpers (hash/verify/strength) + RBAC for reset/change/login (44 tests pass)
- [x] Global enforcement: dashboard layout redirects mustChangePassword users to /change-password
- [x] Live endpoint check: auth.passwordLogin returns 401 for bad credentials (DB-backed)
- [x] All tests pass (44) + TypeScript clean (0 errors)

## Round 7: Password UX
- [x] Inline password requirement hint + validity check on create-login form (disable submit until valid)
- [x] Inline password requirement hint on reset-password dialog (disable save until valid)
- [x] Shared client-side password validation helper (validatePassword in lib/ccm) matching server policy
- [x] Same inline validation + match check applied to Change Password page
