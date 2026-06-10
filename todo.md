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
