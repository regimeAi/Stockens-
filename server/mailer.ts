import { config } from "./config.ts";

// Transactional email over HTTPS (works on hosts that block SMTP ports, like Render's free plan).
//  - Brevo: BREVO_API_KEY. Lets you send from a verified personal address (e.g. Gmail), no domain needed.
//  - Resend: RESEND_API_KEY. Needs a verified domain to email anyone other than yourself.

export const mailConfigured = () => !!(config.mail.from && (config.mail.brevoKey || config.mail.resendKey));

export async function sendMail(to: string, subject: string, text: string, html: string) {
  if (!mailConfigured()) throw new Error("email not configured");
  const { from, fromName } = config.mail;
  const res = config.mail.brevoKey
    ? await fetch(`${config.mail.brevoBase}/v3/smtp/email`, {
        method: "POST",
        headers: { "api-key": config.mail.brevoKey, "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ sender: { email: from, name: fromName }, to: [{ email: to }], subject, textContent: text, htmlContent: html }),
        signal: AbortSignal.timeout(15_000),
      })
    : await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { authorization: `Bearer ${config.mail.resendKey}`, "content-type": "application/json" },
        body: JSON.stringify({ from: `${fromName} <${from}>`, to: [to], subject, text, html }),
        signal: AbortSignal.timeout(15_000),
      });
  if (!res.ok) throw new Error(`mail ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function resetEmail(link: string) {
  const text = `Someone (hopefully you) asked to reset your Stockens password.\n\nSet a new password here (the link works for 1 hour):\n${link}\n\nIf you didn't ask for this, ignore this email — your password won't change.`;
  const html = `<div style="font-family:system-ui,-apple-system,sans-serif;max-width:480px;margin:auto;padding:24px;color:#0b0b0b">
<h2 style="margin:0 0 12px">Reset your Stockens password</h2>
<p>Someone (hopefully you) asked to reset your password. This link works for 1 hour.</p>
<p><a href="${esc(link)}" style="display:inline-block;background:#2a78d6;color:#fff;padding:12px 20px;border-radius:10px;text-decoration:none;font-weight:600">Set a new password</a></p>
<p style="color:#52514e;font-size:13px">If you didn't ask for this, ignore this email — your password won't change.</p></div>`;
  return { subject: "Reset your Stockens password", text, html };
}
