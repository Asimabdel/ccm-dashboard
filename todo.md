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
- [ ] Implement urgent symptom alerts to practice manager
- [ ] Create escalation notifications to providers
- [ ] Add staff reminders for patients not reached
- [ ] Add staff reminders for missing documentation
- [ ] Implement billing readiness notifications
- [ ] Create notification center UI

## Reporting & Analytics
- [ ] Create monthly CCM completion report
- [ ] Build staff productivity report
- [ ] Create provider panel performance report
- [ ] Build clinic performance report
- [ ] Create high-risk patient report
- [ ] Build patients not reached report
- [ ] Create billing readiness report
- [ ] Implement export to Excel/CSV functionality

## Design & UI/UX
- [x] Apply Scandinavian minimalist aesthetic
- [x] Implement pale cool gray background with generous spacing
- [x] Use bold black sans-serif typography with thin subtitles
- [x] Add soft pastel blue and blush pink geometric accents
- [ ] Create consistent component library
- [ ] Implement responsive design for mobile/tablet
- [ ] Add loading states and empty states
- [ ] Create error handling UI

## Testing & Quality Assurance
- [ ] Write unit tests for database queries
- [ ] Write tests for tRPC procedures
- [ ] Write tests for LLM note generation
- [ ] Write tests for billing readiness logic
- [ ] Write tests for notification system
- [ ] Test role-based access control
- [ ] Test monthly worklist generation
- [ ] Test escalation workflow

## Deployment & Documentation
- [ ] Create API documentation
- [ ] Create user guide for each role
- [ ] Create admin setup guide
- [ ] Create staff training guide
- [ ] Test production deployment
- [ ] Set up monitoring and logging
- [ ] Create backup and recovery procedures
