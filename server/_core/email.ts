import { ENV } from "./env";

export type SendEmailInput = {
  to: string;
  subject: string;
  html: string;
  text?: string;
};

export type SendEmailResult = {
  delivered: boolean;
  reason?: string;
};

/**
 * Sends an email through Resend (https://resend.com) when RESEND_API_KEY is
 * configured. Returns { delivered: false, reason } when email is not configured
 * or the upstream call fails — callers should fall back to showing a shareable
 * invite link so the flow never hard-fails.
 */
export async function sendEmail(input: SendEmailInput): Promise<SendEmailResult> {
  if (!ENV.resendApiKey) {
    return { delivered: false, reason: "Email is not configured (missing RESEND_API_KEY)." };
  }
  const from = ENV.emailFrom || "CCM Dashboard <onboarding@resend.dev>";
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: `Bearer ${ENV.resendApiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: [input.to],
        subject: input.subject,
        html: input.html,
        text: input.text,
      }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      console.warn(`[Email] Resend failed (${res.status}): ${detail}`);
      return { delivered: false, reason: `Email provider returned ${res.status}.` };
    }
    return { delivered: true };
  } catch (err) {
    console.warn("[Email] Error sending via Resend:", err);
    return { delivered: false, reason: "Email provider could not be reached." };
  }
}

export function buildInviteEmail(opts: {
  inviteUrl: string;
  role: string;
  inviterName?: string;
  clinicLocation?: string;
}): { subject: string; html: string; text: string } {
  const roleLabel = opts.role.replace(/_/g, " ");
  const subject = "You've been invited to the CCM Operations Dashboard";
  const intro = opts.inviterName
    ? `${opts.inviterName} has invited you`
    : "You have been invited";
  const clinicLine = opts.clinicLocation
    ? `<p style="margin:0 0 8px;color:#475569;">Clinic: <strong>${opts.clinicLocation}</strong></p>`
    : "";
  const html = `
  <div style="font-family:Inter,Arial,sans-serif;max-width:520px;margin:0 auto;padding:32px 24px;color:#0f172a;">
    <h1 style="font-size:20px;margin:0 0 16px;">CCM Operations Dashboard</h1>
    <p style="margin:0 0 12px;color:#334155;">${intro} to join the CCM Operations Dashboard as <strong style="text-transform:capitalize;">${roleLabel}</strong>.</p>
    ${clinicLine}
    <p style="margin:16px 0;color:#334155;">Click the button below and sign in with this email address to accept your invitation. Your role will be assigned automatically.</p>
    <a href="${opts.inviteUrl}" style="display:inline-block;background:#0ea5e9;color:#fff;text-decoration:none;padding:12px 22px;border-radius:10px;font-weight:600;">Accept invitation</a>
    <p style="margin:20px 0 0;color:#94a3b8;font-size:13px;">If the button doesn't work, copy and paste this link:<br>${opts.inviteUrl}</p>
  </div>`;
  const text = `${intro} to join the CCM Operations Dashboard as ${roleLabel}.\n\nAccept your invitation by signing in with this email at:\n${opts.inviteUrl}`;
  return { subject, html, text };
}
