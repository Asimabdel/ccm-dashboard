# CCM Dashboard - Project TODO

## Database & Schema
- [x] Generate and apply database migrations
- [x] Create database relations and indexes
- [ ] Seed initial clinic and provider data

## Core Authentication & User Management
- [x] Implement role-based access control (Admin, Staff, Provider, Billing, Front Desk)
- [ ] Create user profile management
- [x] Implement clinic location assignment for staff
- [x] Add language preferences for staff

## Patient Management
- [x] Create patient database with full profiles
- [ ] Implement patient enrollment workflow
- [x] Add chronic conditions management
- [ ] Implement patient search and filtering
- [x] Add patient risk level assignment
- [ ] Create patient detail view with history

## Monthly CCM Worklist
- [ ] Auto-generate monthly CCM tasks for active patients
- [x] Implement worklist filtering by status, priority, staff, clinic, provider
- [ ] Create status label system (Not Started, Called No Answer, In Progress, Completed, Ready for Billing, etc.)
- [ ] Implement priority levels (High, Medium, Low)
- [ ] Add bulk status update functionality
- [ ] Create monthly reset/rollover logic

## Staff Assignment Dashboard
- [x] Create assignment interface for practice manager
- [x] Implement manual patient assignment
- [x] Implement bulk assignment by provider/clinic/language
- [x] Add rule-based assignment by risk level and workload
- [x] Show staff workload and assignment counts
- [ ] Create assignment history tracking

## CCM Call Workflow & Documentation
- [x] Create guided call script interface
- [x] Implement structured call questions form
- [x] Build built-in timer (start/pause/stop)
- [ ] Add manual time entry capability
- [x] Create call response documentation form
- [x] Implement LLM-powered note generation from workflow responses
- [ ] Create generated note review and edit interface
- [x] Add note save and completion tracking

## Provider Escalation System
- [ ] Create escalation flag interface for staff
- [ ] Implement escalation reason selection
- [ ] Build provider escalation dashboard
- [ ] Create escalation status tracking (Pending, Reviewed, Action Needed, Completed)
- [ ] Add provider review and action recommendation interface
- [ ] Implement escalation notifications

## Follow-Up & Appointment Tracking
- [ ] Create follow-up item types (Office Visit, Lab Work, Referral, etc.)
- [ ] Implement follow-up status tracking (Pending, Scheduled, Completed)
- [ ] Add appointment scheduling integration
- [ ] Create follow-up reminder system
- [ ] Build follow-up completion tracking

## Role-Based Dashboards
- [x] Admin Dashboard: Overall program status, staff performance, clinic performance, urgent flags
- [x] Staff Dashboard: Assigned patients, due patients, call status, timer, documentation form
- [x] Provider Dashboard: Flagged patients, escalation reasons, CCM note summaries, action recommendations
- [x] Billing Dashboard: Completed CCMs, documentation status, billing readiness, claims tracking
- [x] Front Desk Dashboard: Patients needing appointments, labs, testing, scheduling follow-up

## Billing Readiness Tracker
- [ ] Implement billing readiness checklist
- [ ] Create automated billing status determination
- [ ] Build billing dashboard with readiness metrics
- [ ] Add billing status tracking (Not Started, In Progress, Ready, Billed, Denied, etc.)
- [ ] Create billing export functionality

## Automated Notifications
- [x] Implement urgent symptom alerts to practice manager
- [x] Create escalation notifications to providers
- [x] Add staff reminders for patients not reached
- [x] Add staff reminders for missing documentation
- [x] Implement billing readiness notifications
- [x] Create notification center UI

## Reporting & Analytics
- [x] Create monthly CCM completion report
- [x] Build staff productivity report
- [x] Create provider panel performance report
- [x] Build clinic performance report
- [ ] Create high-risk patient report
- [ ] Build patients not reached report
- [ ] Create billing readiness report
- [ ] Implement export to Excel/CSV functionality

## Design & UI/UX
- [x] Apply Scandinavian minimalist aesthetic
- [x] Implement pale cool gray background with generous spacing
- [x] Use bold black sans-serif typography with thin subtitles
- [x] Add soft pastel blue and blush pink geometric accents
- [x] Create consistent component library
- [x] Implement responsive design for mobile/tablet
- [x] Add loading states and empty states
- [x] Create error handling UI

## Testing & Quality Assurance
- [x] Write unit tests for database queries
- [x] Write tests for tRPC procedures
- [x] Write tests for LLM note generation
- [x] Write tests for billing readiness logic
- [x] Write tests for notification system
- [x] Test role-based access control
- [x] Test monthly worklist generation
- [x] Test escalation workflow

## Deployment & Documentation
- [x] Create API documentation
- [x] Create user guide for each role
- [x] Create admin setup guide
- [x] Create staff training guide
- [x] Test production deployment
- [x] Set up monitoring and logging
- [x] Create backup and recovery procedures
