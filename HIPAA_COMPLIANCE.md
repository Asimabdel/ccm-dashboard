# HIPAA Compliance Summary — CCM Operations Dashboard

_Last updated: June 11, 2026_

This document describes the **technical safeguards built into the application** and, just as importantly, the **administrative, physical, and contractual safeguards your organization must put in place** for the overall system to be HIPAA compliant.

> **Important — please read.** HIPAA compliance is a property of your *whole operating environment*, not of any single piece of software. An application can be *built to support* compliance (which this one is), but it cannot *by itself* make your practice compliant. The items in Section B are your responsibility and are required. In particular, **you must have a signed Business Associate Agreement (BAA) with every vendor that stores, processes, or transmits PHI on your behalf** (hosting, database, email, any AI service, etc.). Without those BAAs in place, the deployment is not HIPAA compliant regardless of the application's features.

---

## A. Technical safeguards implemented in the application

These are the controls that are now in the codebase and verified by automated tests and live checks.

### 1. Access control & authentication (§164.312(a))
- **Unique user identity.** Every user has a unique account (`openId`, email). No shared logins are required.
- **Two sign-in methods:** Manus OAuth (SSO) and admin-provisioned **email + password**.
- **Passwords are never stored in plaintext.** They are hashed with **bcrypt** (per-password salt). The raw password is never written to the database or logs.
- **Password policy:** minimum 8 characters, must contain a letter and a number. Enforced on the server (source of truth) and surfaced inline in the UI.
- **Forced password change on first login.** Admin-set temporary passwords must be changed by the worker before they can use the system; this is enforced globally (the dashboard redirects flagged users to the change-password screen and they cannot navigate around it).
- **Brute-force protection.** After **5 failed attempts within 15 minutes**, the account/identifier is **locked for 15 minutes**. Login errors are intentionally generic ("Incorrect email or password") to prevent **user enumeration**.
- **Role-based access control (least privilege).** Roles: `admin`, `staff` (care coordinator), `provider`, `billing`, `front_desk`. Each role only sees its relevant dashboard, and server-side procedures enforce role checks (`adminProcedure` / `requireRole`) — the UI restrictions are backed by server enforcement, not just hidden buttons.

### 2. Automatic logoff (§164.312(a)(2)(iii))
- **Idle session timeout:** the app automatically logs a user out after **15 minutes of inactivity**, showing a **60-second warning** beforehand so unsaved attention isn't lost. This protects unattended workstations.

### 3. Audit controls (§164.312(b))
- A persistent **audit log** records security- and PHI-relevant events with the acting user, role, timestamp, and (where available) IP address. Logged events include:
  - **PHI access:** viewing a patient (`view_patient`), viewing the patient list (`list_patients`).
  - **PHI changes:** create/update patient, RPM updates, date edits, **bulk imports**.
  - **Account/security:** `login`, `login_failed`, `logout`, `change_password`, `reset_password`, and access/role management (`manage_access`).
- Audit entries are retained even when a user is removed (the user row is referenced by the log), supporting after-the-fact investigation.

### 4. Integrity & transmission security (§164.312(c), (e))
- All traffic to the deployed app is over **HTTPS/TLS** (the platform terminates TLS; the app is served only over `https://`).
- The session cookie is **HttpOnly**, **Secure**, and **SameSite=Lax**, which prevents JavaScript access to the session token and blocks cross-site sending while keeping same-origin login reliable.

### 5. Minimum necessary & data minimization (§164.502(b))
- **Secrets are never sent to the browser.** API responses that return user objects are sanitized to **strip `passwordHash` and `passwordSetAt`** (verified by automated tests and a live check).
- Pre-assigning a role by email follows the **minimum-necessary** principle: a worker receives only the access their role requires.

### 6. Verification
- **60 automated tests pass**, including: RBAC gating per role, password hashing/verification/strength, the full password lifecycle against the live database (create → forced change → old password rejected → new password works), secret-stripping, and brute-force lockout.
- The login lifecycle was additionally verified live end-to-end on the running server.

---

## B. Your organization's responsibilities (required for actual HIPAA compliance)

The application supports compliance, but the following are **administrative, physical, and contractual** controls that **only your organization can put in place**. These are **required** — the system is not HIPAA compliant without them.

### 1. Business Associate Agreements (BAAs) — **mandatory**
You must have a signed BAA with **every vendor that creates, receives, maintains, or transmits PHI** for you, including but not limited to:
- The **application hosting / cloud platform** that runs and stores this app and its database.
- The **email provider** used to send any messages that could contain PHI.
- Any **AI / LLM provider** used by the "Generate with AI" feature (note: avoid sending PHI to any AI service that is not covered by a BAA).
- Any analytics, logging, backup, or monitoring service.

If a given platform does not offer a BAA, you must not route PHI through it. **Confirm BAA coverage before going live with real patient data.**

### 2. Administrative safeguards (§164.308)
- Designate a **HIPAA Security Officer** and **Privacy Officer**.
- Complete and maintain a documented **Security Risk Assessment** and risk-management plan.
- Maintain **written policies and procedures** (sanction policy, access authorization/termination, incident response, breach notification).
- Provide **workforce HIPAA training** and track completion.
- Enforce **timely deprovisioning**: remove access in the app immediately when staff leave or change roles (use Team & Access → Remove).

### 3. Physical safeguards (§164.310)
- Control physical access to any device that can reach the system; enforce device encryption, screen locks, and clean-desk practices.

### 4. Data lifecycle
- Define and configure **backups and disaster recovery**, with retention/disposal policies for PHI and audit logs.
- Establish a **breach notification** process consistent with the HIPAA Breach Notification Rule.

### 5. Operational hygiene specific to this app
- Issue temporary passwords to workers over a **secure channel** (not shared inboxes or unencrypted SMS), and have them change it on first login (already enforced).
- Periodically **review the audit log** and the **Team & Access** roster.
- Keep admin accounts to the **minimum necessary** number.

---

## C. Recommended future enhancements (not yet implemented)
These would further strengthen the security posture but were not part of the current scope:
- **Multi-factor authentication (MFA)** for all accounts (strongly recommended for PHI systems).
- An **in-app audit-log viewer with export** for compliance reviews.
- **Configurable** password-expiry and idle-timeout values per organization policy.
- Automated **export of the audit trail** to immutable/WORM storage for long-term retention.

---

## D. Plain-language bottom line
- **What the app does for you:** strong authentication, hashed passwords, brute-force lockout, role-based least privilege, automatic logoff, comprehensive audit logging, TLS in transit, and no leakage of password hashes to the browser.
- **What you must do:** sign BAAs with all PHI-handling vendors, complete a risk assessment, adopt written policies, train staff, manage access promptly, and handle backups/breach procedures.
- **One-line summary:** *The software is built to be HIPAA-supporting; your signed BAAs and administrative program are what make the overall deployment HIPAA-compliant.*

_This document is a technical summary to assist your compliance program. It is not legal advice. Consult your compliance officer or legal counsel to validate your specific obligations._
