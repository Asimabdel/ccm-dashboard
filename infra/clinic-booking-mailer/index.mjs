import { SNSClient, PublishCommand } from "@aws-sdk/client-sns";
import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";

// mypcpdr.com booking wizard → this function (API Gateway 37zhvbvb1g).
// Each request goes to MyPCP (Website bookings page + a call task for that clinic's front desk)
// and is emailed to Care@ as a backup. If MyPCP can't be reached, the email still goes out.

const sns = new SNSClient({});
const ses = new SESv2Client({});
const lambda = new LambdaClient({});
const TOPIC = "arn:aws:sns:us-east-1:594862665272:clinic-booking-requests";
const MAILBOX = "Care@mypcpdr.com";
const ALLOWED_ORIGINS = ["https://mypcpdr.com", "https://www.mypcpdr.com"];

const clean = (s, max) => String(s || "").replace(/[\r\n<>&"]/g, " ").trim().slice(0, max);

const htmlEmail = (d) => {
  const row = (label, value, extra) => `
    <tr>
      <td style="padding:9px 0;font-size:12px;letter-spacing:.08em;color:#8a8f9c;text-transform:uppercase;vertical-align:top;width:130px;">${label}</td>
      <td style="padding:9px 0;font-size:16px;color:#122B5C;font-weight:600;">${extra || value}</td>
    </tr>`;
  const telHref = "tel:+1" + d.phone.replace(/\D/g, "").slice(-10);
  return `<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#F8F9FC;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F8F9FC;padding:28px 12px;"><tr><td align="center">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#ffffff;border-radius:16px;overflow:hidden;border:1px solid #e3e6ee;">
  <tr><td style="background:#122B5C;padding:22px 30px;">
    <p style="margin:0;font-family:Georgia,serif;font-size:21px;color:#ffffff;">New appointment request</p>
    <p style="margin:4px 0 0;font-family:Arial,sans-serif;font-size:12px;color:#9fb4dd;letter-spacing:.1em;">MYPCP DR &middot; MYPCPDR.COM</p>
  </td></tr>
  <tr><td style="height:4px;background:#A6192E;font-size:0;">&nbsp;</td></tr>
  <tr><td style="padding:26px 30px 8px;font-family:Arial,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
      ${row("Patient", d.name)}
      ${row("Phone", d.phone, `<a href="${telHref}" style="color:#A6192E;text-decoration:none;">${d.phone}</a>`)}
      ${row("Location", d.location || "No preference")}
      ${row("Provider", d.provider || "First available")}
      ${row("Visit type", d.visitType || "Not specified")}
      ${row("Preferred", d.preferred || "No preference")}
      ${row("Submitted", d.now + " (Houston time)")}
    </table>
  </td></tr>
  <tr><td style="padding:14px 30px 6px;" align="center">
    <a href="${telHref}" style="display:inline-block;background:#A6192E;color:#ffffff;font-family:Arial,sans-serif;font-size:15px;font-weight:bold;text-decoration:none;padding:13px 34px;border-radius:999px;">Call ${d.name.split(" ")[0]} to confirm</a>
  </td></tr>
  <tr><td style="padding:18px 30px 26px;font-family:Arial,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F8F9FC;border-radius:12px;">
      <tr><td style="padding:14px 18px;">
        <p style="margin:0 0 6px;font-size:11px;letter-spacing:.08em;color:#8a8f9c;">NEXT STEPS</p>
        <p style="margin:0;font-size:14px;color:#122B5C;line-height:1.7;">1. Call the patient to confirm the time<br>2. Enter the appointment in Practice Fusion<br>3. Mark it in MyPCP &rarr; Website bookings (it's there already)</p>
      </td></tr>
    </table>
  </td></tr>
  <tr><td style="padding:0 30px 22px;font-family:Arial,sans-serif;" align="center">
    <p style="margin:0;font-size:11px;color:#b7bcc7;">Sent automatically by the mypcpdr.com booking system</p>
  </td></tr>
</table>
</td></tr></table>
</body></html>`;
};

export const handler = async (event) => {
  const origin = (event.headers && (event.headers.origin || event.headers.Origin)) || "";
  const corsOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  const cors = {
    "Access-Control-Allow-Origin": corsOrigin,
    "Access-Control-Allow-Methods": "POST,OPTIONS",
    "Access-Control-Allow-Headers": "content-type",
  };
  if (event.requestContext?.http?.method === "OPTIONS") {
    return { statusCode: 204, headers: cors, body: "" };
  }
  let data;
  try {
    data = JSON.parse(event.body || "{}");
  } catch {
    return { statusCode: 400, headers: cors, body: JSON.stringify({ ok: false }) };
  }
  if (data.website) {
    return { statusCode: 200, headers: cors, body: JSON.stringify({ ok: true }) };
  }
  const name = clean(data.name, 80);
  const phone = clean(data.phone, 30);
  const location = clean(data.location, 40);
  const provider = clean(data.provider, 60);
  const visitType = clean(data.visitType, 60);
  const preferred = clean(data.preferred, 80);
  if (!name || !phone || phone.replace(/\D/g, "").length < 10) {
    return { statusCode: 400, headers: cors, body: JSON.stringify({ ok: false, error: "name and valid phone required" }) };
  }
  const now = new Date().toLocaleString("en-US", { timeZone: "America/Chicago" });
  const subject = ("Appointment request: " + name + " - " + (location || "any location")).slice(0, 99);
  const textBody = [
    "New appointment request from mypcpdr.com",
    "",
    "Name:      " + name,
    "Phone:     " + phone,
    "Location:  " + (location || "no preference"),
    "Provider:  " + (provider || "first available"),
    "Visit:     " + (visitType || "not specified"),
    "Preferred: " + (preferred || "no preference"),
    "",
    "Submitted: " + now + " (Houston time)",
    "",
    "Next step: call the patient to confirm, enter the appointment in Practice Fusion, then mark it in MyPCP > Website bookings.",
  ].join("\n");

  // Hand the request to MyPCP (async; never blocks or fails the booking).
  try {
    await lambda.send(new InvokeCommand({
      FunctionName: "ccm-app",
      InvocationType: "Event",
      Payload: new TextEncoder().encode(JSON.stringify({ __job: "website-booking", booking: { name, phone, location, provider, visitType, preferred } })),
    }));
  } catch (e) {
    console.error("MyPCP hand-off failed; email still sent");
  }

  try {
    await ses.send(new SendEmailCommand({
      FromEmailAddress: "MyPCP Dr Bookings <" + MAILBOX + ">",
      Destination: { ToAddresses: [MAILBOX] },
      Content: {
        Simple: {
          Subject: { Data: subject },
          Body: {
            Html: { Data: htmlEmail({ name, phone, location, provider, visitType, preferred, now }) },
            Text: { Data: textBody },
          },
        },
      },
    }));
  } catch (e) {
    await sns.send(new PublishCommand({ TopicArn: TOPIC, Subject: subject, Message: textBody }));
  }
  return { statusCode: 200, headers: cors, body: JSON.stringify({ ok: true }) };
};
